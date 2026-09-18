import './setup-db';
import { describe, it, expect, beforeEach } from 'vitest';
import db from '@/lib/db';
import { readJobDocuments, saveJobDocument, promoteDocumentsToApplication } from '@/lib/apply/documents';
import { seedJob } from './setup-db';

/**
 * REGRESSION: generating a document must never fabricate an application.
 *
 * The bug this guards: `prepareSubmission` and both `/api/generate/*` routes cached a generated
 * cover letter by INSERTing into `my_applications` with `status = 'applied'` when no row existed.
 * That was cosmetic until the matcher began excluding applied jobs by default — after which merely
 * OPENING the auto-apply preview removed the job from the match list, the digest, and all three
 * rating paths. Three such rows existed in the live database, none with `submitted_via` and none
 * with an `apply_audit` entry.
 *
 * The browser E2E (17 checks) did not catch this: the UI looks perfectly healthy while it happens.
 */
describe('generated documents never fabricate an application', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM my_applications').run();
    db.prepare('DELETE FROM job_documents').run();
  });

  it('caching a cover letter creates NO application row', () => {
    const jobId = seedJob(db);

    saveJobDocument(jobId, 'cover_letter', 'Dear hiring team, ...');

    const apps = db.prepare('SELECT COUNT(*) c FROM my_applications').get() as { c: number };
    expect(apps.c).toBe(0);
    expect(readJobDocuments(jobId).coverLetter).toBe('Dear hiring team, ...');
  });

  it('caching a resume variant creates NO application row', () => {
    const jobId = seedJob(db);

    saveJobDocument(jobId, 'resume_variant', '# Tailored resume');

    const apps = db.prepare('SELECT COUNT(*) c FROM my_applications').get() as { c: number };
    expect(apps.c).toBe(0);
    expect(readJobDocuments(jobId).resumeVariant).toBe('# Tailored resume');
  });

  it('a job with only cached documents is STILL returned by the applied-exclusion filter', () => {
    const jobId = seedJob(db);
    saveJobDocument(jobId, 'cover_letter', 'preview only');

    // The exact predicate the matcher uses to exclude applied jobs.
    const visible = db
      .prepare(
        `SELECT 1 FROM job_postings j
          WHERE j.id = ?
            AND NOT EXISTS (SELECT 1 FROM my_applications a WHERE a.job_id = j.id)`,
      )
      .get(jobId);

    expect(visible).toBeTruthy();
  });

  it('when a real application exists, the document is written to it instead of the cache', () => {
    const jobId = seedJob(db);
    db.prepare(`INSERT INTO my_applications (job_id, status) VALUES (?, 'applied')`).run(jobId);

    saveJobDocument(jobId, 'cover_letter', 'the real one');

    const app = db
      .prepare('SELECT cover_letter FROM my_applications WHERE job_id = ?')
      .get(jobId) as { cover_letter: string };
    expect(app.cover_letter).toBe('the real one');
    // and nothing leaked into the speculative cache
    const cached = db.prepare('SELECT COUNT(*) c FROM job_documents WHERE job_id = ?').get(jobId) as { c: number };
    expect(cached.c).toBe(0);
  });

  it('promotion moves cached documents onto a real application and clears the cache', () => {
    const jobId = seedJob(db);
    saveJobDocument(jobId, 'cover_letter', 'drafted before applying');
    db.prepare(`INSERT INTO my_applications (job_id, status) VALUES (?, 'applied')`).run(jobId);

    promoteDocumentsToApplication(jobId);

    const app = db
      .prepare('SELECT cover_letter FROM my_applications WHERE job_id = ?')
      .get(jobId) as { cover_letter: string };
    expect(app.cover_letter).toBe('drafted before applying');
    const cached = db.prepare('SELECT COUNT(*) c FROM job_documents WHERE job_id = ?').get(jobId) as { c: number };
    expect(cached.c).toBe(0);
  });

  it('promotion does not overwrite what was actually sent', () => {
    const jobId = seedJob(db);
    saveJobDocument(jobId, 'cover_letter', 'stale draft');
    db.prepare(`INSERT INTO my_applications (job_id, status, cover_letter) VALUES (?, 'applied', ?)`)
      .run(jobId, 'what was really submitted');

    promoteDocumentsToApplication(jobId);

    const app = db
      .prepare('SELECT cover_letter FROM my_applications WHERE job_id = ?')
      .get(jobId) as { cover_letter: string };
    expect(app.cover_letter).toBe('what was really submitted');
  });

  it('promotion moves cached resume_tex onto a real application', () => {
    const jobId = seedJob(db);
    saveJobDocument(jobId, 'resume_tex', '\\documentclass{article}\\begin{document}Tailored Tex\\end{document}');
    db.prepare(`INSERT INTO my_applications (job_id, status) VALUES (?, 'applied')`).run(jobId);

    promoteDocumentsToApplication(jobId);

    const app = db
      .prepare('SELECT resume_tex FROM my_applications WHERE job_id = ?')
      .get(jobId) as { resume_tex: string };
    expect(app.resume_tex).toContain('Tailored Tex');
    const cached = db.prepare('SELECT COUNT(*) c FROM job_documents WHERE job_id = ?').get(jobId) as { c: number };
    expect(cached.c).toBe(0);
  });

  it('promotion moves cached tailored_score and default_score onto a real application', () => {
    const jobId = seedJob(db);
    db.prepare(`
      INSERT INTO job_documents (job_id, tailored_score, default_score, updated_at)
      VALUES (?, 85, 60, CURRENT_TIMESTAMP)
      ON CONFLICT(job_id) DO UPDATE SET tailored_score = 85, default_score = 60
    `).run(jobId);
    db.prepare(`INSERT INTO my_applications (job_id, status) VALUES (?, 'applied')`).run(jobId);

    promoteDocumentsToApplication(jobId);

    const app = db
      .prepare('SELECT tailored_score, default_score FROM my_applications WHERE job_id = ?')
      .get(jobId) as { tailored_score: number; default_score: number };
    expect(app.tailored_score).toBe(85);
    expect(app.default_score).toBe(60);
  });
});

describe('preview never dead-ends on work it deliberately skipped', () => {
  /**
   * REGRESSION: making the preview skip LLM generation (to fix a 277s hang) introduced a new
   * failure — picking "AI-tailored" before the variant existed returned
   * "Cannot render resume PDF — no resume markdown", which is nonsense when the user has an
   * uploaded PDF on file. A preview must fall back to what it has and explain, not error.
   *
   * It also reported `strategy: 'greenhouse'` on every such error because the strategy was
   * hardcoded in the error returns, so the UI told the user to apply manually to the wrong portal.
   */
  it('never returns the misleading "no resume markdown" error when a PDF is on file', async () => {
    // NOTE: `prepareSubmission` does a LIVE url check before building a plan, so a synthetic URL
    // can't reach `ok: true` offline — the happy path is covered end-to-end through the route
    // instead (verified: `?resume=tailored` -> ok=true with a `resume_variant_pending` warning).
    // What this locks down is the invariant that survives without network: the dead-end message
    // that told a user with a perfectly good uploaded résumé to "re-upload your resume" is gone.
    const { prepareSubmission } = await import('@/lib/apply/prepare');
    const jobId = seedJob(db, { url: 'https://job-boards.greenhouse.io/acme/jobs/123' });
    db.prepare('DELETE FROM my_profile').run();
    db.prepare(
      `INSERT INTO my_profile (id, raw_text, parsed_json, pdf_blob, pdf_filename)
       VALUES (1, 'x', ?, ?, 'Mine.pdf')`,
    ).run(JSON.stringify({ name: 'Test User', email: 't@example.com', skills: [] }), Buffer.from('%PDF-1.4 mine'));

    const res = await prepareSubmission(jobId, { resumeSource: 'tailored', generateMissing: false });

    expect(res.error ?? '').not.toMatch(/no resume markdown/i);
    expect(res.error ?? '').not.toMatch(/Re-upload your resume/i);
  }, 60_000);

  it('an error reports the REAL strategy, never a hardcoded greenhouse', async () => {
    const { prepareSubmission } = await import('@/lib/apply/prepare');
    const jobId = seedJob(db, { url: 'https://job-boards.greenhouse.io/acme/jobs/456' });
    db.prepare('DELETE FROM my_profile').run(); // force the "no profile" error path

    const res = await prepareSubmission(jobId, { generateMissing: false });

    expect(res.ok).toBe(false);
    // A Greenhouse URL now routes to `browser`; the error must say so, not claim 'greenhouse'.
    expect(res.strategy).not.toBe('greenhouse');
  }, 30_000);
});
