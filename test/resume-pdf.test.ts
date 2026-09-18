import './setup-db';
import { describe, it, expect, beforeEach } from 'vitest';
import db from '@/lib/db';
import { seedJob } from './setup-db';

/**
 * REGRESSION: viewing your résumé must serve the PDF you uploaded, not generate a new one.
 *
 * The apply dialog POSTed an EMPTY body to `/api/jobs/[id]/resume.pdf`, so the route never learned
 * which source the user wanted and fell straight through to `generateResumeVariant` — an LLM call
 * plus a Playwright render — even though `apply_settings.resumeSource` defaults to 'original' and
 * the uploaded PDF (235KB) was sitting in `my_profile.pdf_blob`. The user clicked "resume", got a
 * blank `about:blank` tab, and waited 35-70s (or forever, when the free model failed) to be shown a
 * document that already existed.
 *
 * The route is exercised through its exported POST handler so the real decision path is covered.
 */
describe('resume.pdf source selection', () => {
  let jobId: number;

  beforeEach(() => {
    jobId = seedJob(db);
    db.prepare('DELETE FROM job_documents').run();
    db.prepare('DELETE FROM my_profile').run();
  });

  const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/jobs/[id]/resume.pdf/route');
    const req = new Request('http://localhost/api/jobs/1/resume.pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return POST(req as never, { params: Promise.resolve({ id: String(jobId) }) });
  };

  it('serves the stored original PDF without any LLM or render', async () => {
    const bytes = Buffer.from('%PDF-1.4\nstored-original\n%%EOF');
    db.prepare(
      `INSERT INTO my_profile (id, raw_text, parsed_json, pdf_blob, pdf_filename)
       VALUES (1, 'x', '{}', ?, 'MyResume.pdf')`,
    ).run(bytes);

    const res = await post({ source: 'original' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    // `inline`, so the browser renders it in the tab rather than downloading it.
    expect(res.headers.get('content-disposition')).toContain('inline');
    expect(res.headers.get('content-disposition')).toContain('MyResume.pdf');
    const out = Buffer.from(await res.arrayBuffer());
    expect(out.equals(bytes)).toBe(true);
  });

  it('defaults to the original when no source is given (the dialog used to send nothing)', async () => {
    const bytes = Buffer.from('%PDF-1.4\ndefaulted\n%%EOF');
    db.prepare(
      `INSERT INTO my_profile (id, raw_text, parsed_json, pdf_blob, pdf_filename)
       VALUES (1, 'x', '{}', ?, 'R.pdf')`,
    ).run(bytes);

    const res = await post({}); // exactly what the dialog sent before

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('explicit markdown still wins (the "download this variant" path)', async () => {
    db.prepare(
      `INSERT INTO my_profile (id, raw_text, parsed_json, pdf_blob, pdf_filename)
       VALUES (1, 'x', '{}', ?, 'R.pdf')`,
    ).run(Buffer.from('%PDF-1.4 original'));

    // Rendering markdown needs Playwright; we only assert it does NOT short-circuit to the
    // original, i.e. the caller's explicit content is respected.
    const res = await post({ markdown: '# Someone Else\n\nContent' });
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString('utf8', 0, 20)).not.toContain('original');
  }, 60_000);
});
