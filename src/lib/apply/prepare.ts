// prepareSubmission — the orchestrator that builds a SubmissionPlan for a given jobId.
//
// Flow:
//   1. Load job + profile from DB
//   2. Identify portal strategy from job.url
//   3. Load or generate cover_letter + resume_variant markdown
//   4. Render resume PDF (Playwright)
//   5. Per-portal: fetch the form schema, answer each question, build a Plan
//   6. Return the Plan for preview, or throw if cannot be auto-applied
//
// The Plan is then either previewed in the UI or submitted directly via the
// matching submitter module.

import db from '../db';
import { readJobDocuments, saveJobDocument } from './documents';
import { applicationUrl, identifySubmissionStrategy, type SubmissionStrategy } from './router';
import { buildGreenhousePlan, type GhSubmissionPlan } from './greenhouse';
import { buildAshbyPlan, type AshbySubmissionPlan } from './ashby';
import { getApplyConfig } from './questions';
import { generateCoverLetter, generateResumeVariant, generateLatexResume } from '../llm';
import { renderResumePdf } from './render-pdf';
import { compileLatexWithRepair, hasLatexCompiler, looksLikeLatexTemplate, latexPdfFilename, spliceLatexContent, isStaleTailoredTex } from './latex';
import { checkJobUrl } from '../link-check';
import type { LinkedInSubmissionPlan, NaukriSubmissionPlan } from './platform';

// Browser-strategy plan — no field schema (since we open the page in a browser and let
// the user submit); just a placeholder that carries the URL and resolved attachments.
export interface BrowserSubmissionPlan {
  strategy: 'browser';
  url: string;
  jobTitle: string;
  company: string;
  // Pre-computed for the UI preview: which fields we'll attempt to fill from profile.
  fields: Array<{
    name: string;          // 'first_name' etc. — used as override key
    type: string;          // 'text' | 'file' | 'textarea'
    label: string;
    required: boolean;
    value: string | { filename: string; mimeType: string; sizeBytes: number } | null;
    source?: 'defaults';
  }>;
  attachments: {
    resume?: { filename: string; mimeType: string; bytes: Uint8Array };
    coverLetter?: { filename: string; mimeType: string; bytes: Uint8Array };
  };
}

interface JobRow {
  id: number;
  source: string;
  company: string;
  title: string;
  location: string;
  description: string;
  url: string;
  url_status: string | null;
  expired_at: string | null;
}

interface ProfileRow {
  parsed_json: string;
  pdf_blob: Buffer | null;
  pdf_filename: string | null;
  resume_tex: string | null;
}

export type ResumeSource = 'tailored' | 'original';

interface ApplicationRow {
  cover_letter: string | null;
  resume_variant: string | null;
  resume_tex: string | null;
}

export type SubmissionPlan =
  | GhSubmissionPlan
  | AshbySubmissionPlan
  | BrowserSubmissionPlan
  | LinkedInSubmissionPlan
  | NaukriSubmissionPlan;

export interface PrepareWarning {
  code: string;
  message: string;
}

export interface PrepareResult {
  ok: boolean;
  plan?: SubmissionPlan;
  strategy: SubmissionStrategy;
  warnings: PrepareWarning[];
  error?: string;
  resumeSource?: ResumeSource;          // which resume the plan attached
  resumeSourceAvailable?: { original: boolean }; // whether the original PDF exists to choose
  hasTailored?: boolean;
}

export async function prepareSubmission(
  jobId: number,
  opts: {
    resumeSource?: ResumeSource;
    generateMissing?: boolean;
    forceRegenerate?: boolean;
  } = {},
): Promise<PrepareResult> {
  const generateMissing = opts.generateMissing !== false;
  const warnings: PrepareWarning[] = [];

  // 1. Load job
  const job = db.prepare('SELECT id, source, company, title, location, description, url, url_status, expired_at FROM job_postings WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) return { ok: false, strategy: 'browser', warnings, error: 'Job not found' };

  // 1b. Validity gate — never spend effort applying to a closed/dead posting.
  // Trust a recent DB verdict; otherwise do one live check now.
  if (job.expired_at || job.url_status === 'dead') {
    return { ok: false, strategy: 'browser', warnings, error: 'This posting looks closed or expired — it was retired from the active list. Verify the link before applying.' };
  }
  if (job.url) {
    const liveness = await checkJobUrl(job.url);
    if (liveness === 'dead') {
      // Record it so the matcher/prune drop it too.
      try { db.prepare("UPDATE job_postings SET url_status='dead', url_checked_at=datetime('now'), expired_at=datetime('now') WHERE id=?").run(jobId); } catch { /* column race */ }
      return { ok: false, strategy: 'browser', warnings, error: 'The job URL no longer resolves (posting closed). Skipping to avoid a wasted application.' };
    }
  }

  // 2. Identify strategy
  const strategyMatch = identifySubmissionStrategy(job.url);
  const config = getApplyConfig();

  // Postings we can't help with at all (Lever, Indeed, Glassdoor, generic job boards, ...) — say
  // so plainly rather than reporting an unimplemented "strategy", which read like a bug to the
  // user. LinkedIn and Naukri are NOT here: they have dedicated adapters in src/lib/apply/.
  if (strategyMatch.strategy === 'manual') {
    return {
      ok: false,
      strategy: strategyMatch.strategy,
      warnings,
      error: 'This job board cannot be filled in automatically — use "Apply on company site".',
    };
  }

  // Portal allowlist check
  if (!config.portals[strategyMatch.strategy]) {
    return {
      ok: false,
      strategy: strategyMatch.strategy,
      warnings,
      error: `${strategyMatch.strategy} is turned off in Settings → Auto-apply.`,
    };
  }

  // 3. Load profile
  const profileRow = db.prepare('SELECT parsed_json, pdf_blob, pdf_filename, resume_tex FROM my_profile WHERE id = 1').get() as ProfileRow | undefined;
  if (!profileRow) return { ok: false, strategy: 'greenhouse', warnings, error: 'No resume uploaded. Visit /profile first.' };
  const profile = JSON.parse(profileRow.parsed_json);

  // Which resume to attach: default to AI-TAILORED variant.
  // Default comes from apply settings; per-submission override via opts.resumeSource.
  const resumeSource: ResumeSource = opts.resumeSource || (config.resumeSource as ResumeSource) || 'tailored';

  // Profile completeness checks — warn but don't block
  if (!profile.email) warnings.push({ code: 'missing_email', message: 'Profile has no email — applications will fail. Edit /profile.' });
  if (!profile.phone) warnings.push({ code: 'missing_phone', message: 'Profile has no phone — most portals require it.' });
  if (!profile.name) warnings.push({ code: 'missing_name', message: 'Profile has no name.' });

  // 4. Load or generate cover letter + resume variant
  const app = db.prepare('SELECT cover_letter, resume_variant, resume_tex FROM my_applications WHERE job_id = ?').get(jobId) as ApplicationRow | undefined;
  // Read through BOTH stores: the application record (what was actually sent) wins, then the
  // speculative cache. Reading only `app` here would mean every preview regenerated from scratch.
  const cachedDocs = readJobDocuments(jobId);
  let coverLetterMd = app?.cover_letter || cachedDocs.coverLetter || null;
  let resumeMd = app?.resume_variant || cachedDocs.resumeVariant || null;
  let resumeTex = app?.resume_tex || cachedDocs.resumeTex || null;

  // Stale detection: if forceRegenerate was requested or the cached LaTeX draft contains the
  // raw unmodified base template's tools line, treat it as a cache miss and regenerate fresh.
  if (opts.forceRegenerate || isStaleTailoredTex(resumeTex, profileRow.resume_tex)) {
    resumeTex = null;
    resumeMd = null;
  }
  const hasTailored = !!(resumeMd || resumeTex);

  if (!coverLetterMd && generateMissing) {
    try {
      const result = await generateCoverLetter(profile, job.title, job.company, job.description || '');
      coverLetterMd = result.text;
      // Cache it WITHOUT fabricating an application — see src/lib/apply/documents.ts.
      saveJobDocument(jobId, 'cover_letter', coverLetterMd);
    } catch (e) {
      warnings.push({ code: 'cover_letter_failed', message: `Cover letter generation failed: ${(e as Error).message.slice(0, 100)}` });
    }
  }

  // 5. Resolve the resume PDF to attach.
  const safeName = (profile.name || 'candidate').replace(/[^\w-]+/g, '_');
  let pdf: { bytes: Uint8Array; filename: string } | null = null;
  const hasOriginal = !!profileRow.pdf_blob;

  /** The user's real uploaded PDF, when we have the bytes. */
  const originalPdf = () => ({
    bytes: new Uint8Array(profileRow.pdf_blob as Buffer),
    filename: profileRow.pdf_filename || `${safeName}_Resume.pdf`,
  });

  if (resumeSource === 'original' && hasOriginal) {
    // Send the user's real uploaded PDF as-is — no LLM, no rendering.
    pdf = originalPdf();
  } else if (!hasTailored && !generateMissing && hasOriginal) {
    // PREVIEW of the AI-tailored option, before the variant exists: use uploaded PDF as preview baseline
    pdf = originalPdf();
  } else {
    if (resumeSource === 'original' && !hasOriginal) {
      warnings.push({ code: 'original_unavailable', message: 'Original PDF not stored for the active resume — re-upload it on /profile to send the original. Using the AI-tailored resume for now.' });
    }
    // AI-tailored path. Two renderers: the USER'S OWN LaTeX template (Overleaf design preserved)
    // when a template + compiler exist, else the Markdown one. Both only use facts from the resume.
    let latexUsed = false;
    const latexEnabled =
      looksLikeLatexTemplate(profileRow.resume_tex) && (await hasLatexCompiler());
    if (latexEnabled) {
      // Validate-then-cache: a broken draft must never be stored (it would wedge the LaTeX lane
      // forever). A cached tex is deterministic-repaired FIRST (`spliceLatexContent` re-runs
      // `repairMacroArguments`, padding the custom macros' dropped args) so a pre-repair-era draft
      // heals without an LLM call; then compile, and on failure hand the engine error back to the
      // model for one structural repair pass. Only fall back to markdown when even that fails.
      let tex = resumeTex;
      if (tex) {
        tex = spliceLatexContent(profileRow.resume_tex as string, tex);
      } else if (generateMissing) {
        try {
          const result = await generateLatexResume(profile, profileRow.resume_tex as string, job.title, job.company, job.description || '', { interactive: true });
          tex = result.text;
        } catch (e) {
          warnings.push({ code: 'resume_tex_failed', message: `LaTeX variant generation failed: ${(e as Error).message.slice(0, 100)}` });
        }
      }
      if (tex) {
        try {
          const { bytes, tex: verifiedTex } = await compileLatexWithRepair(
            tex,
            (err) =>
              generateLatexResume(
                profile,
                profileRow.resume_tex as string,
                job.title,
                job.company,
                job.description || '',
                { interactive: true, fixHint: err },
              ).then((r) => r.text),
          );
          pdf = { bytes: new Uint8Array(bytes), filename: latexPdfFilename(profile.name, profileRow.pdf_filename) };
          latexUsed = true;
          saveJobDocument(jobId, 'resume_tex', verifiedTex); // only cache what compiled
        } catch (e) {
          warnings.push({ code: 'latex_compile_failed', message: `LaTeX compile failed — falling back to Markdown: ${(e as Error).message.slice(0, 120)}` });
        }
      }
    }
    if (!latexUsed) {
      // Markdown lane (the original behavior).
      if (!resumeMd && !generateMissing) {
        warnings.push({
          code: 'resume_variant_pending',
          message: 'AI-tailored résumé not generated yet — it will be created when you submit.',
        });
      } else if (!resumeMd) {
        try {
          // A user is waiting on Submit — bounded timeout + local fallback rather than a hard fail.
          const result = await generateResumeVariant(profile, job.title, job.company, job.description || '', { interactive: true });
          resumeMd = result.text;
          saveJobDocument(jobId, 'resume_variant', resumeMd);
        } catch (e) {
          warnings.push({ code: 'resume_variant_failed', message: `Resume variant generation failed: ${(e as Error).message.slice(0, 100)}` });
        }
      }
      if (!resumeMd) {
        if (hasOriginal) {
          pdf = originalPdf();
        } else {
          return { ok: false, strategy: strategyMatch.strategy, warnings, error: 'No résumé available — upload one on /profile.' };
        }
      } else {
        try {
          pdf = await renderResumePdf(resumeMd, profileRow.pdf_filename || `${safeName}_Resume.pdf`);
        } catch (e) {
          return { ok: false, strategy: strategyMatch.strategy, warnings, error: `PDF render failed: ${(e as Error).message}` };
        }
      }
    }
  }

  // 6. Build per-portal plan
  if (!pdf) {
    return { ok: false, strategy: strategyMatch.strategy, warnings, error: 'No résumé available — upload one on /profile.' };
  }
  const coverLetterFilename = `Cover_Letter_${(profile.name || 'candidate').replace(/[^\w-]+/g, '_')}.txt`;

  if (strategyMatch.strategy === 'greenhouse' && strategyMatch.greenhouse) {
    try {
      const plan = await buildGreenhousePlan({
        slug: strategyMatch.greenhouse.boardSlug,
        jobId: strategyMatch.greenhouse.jobId,
        jobTitle: job.title,
        company: job.company,
        jobLocation: job.location,
        jobDescription: job.description,
        profile,
        defaults: config.defaults,
        resumePdfBuf: pdf.bytes,
        resumeFilename: pdf.filename,
        coverLetterText: coverLetterMd || undefined,
        coverLetterFilename,
      });
      return { ok: true, plan, strategy: 'greenhouse', warnings, resumeSource: resumeSource === 'original' && hasOriginal ? 'original' : 'tailored', resumeSourceAvailable: { original: hasOriginal }, hasTailored };
    } catch (e) {
      return { ok: false, strategy: strategyMatch.strategy, warnings, error: `Greenhouse plan build failed: ${(e as Error).message}` };
    }
  }

  if (strategyMatch.strategy === 'browser') {
    // No schema fetch — just hand the URL to the autofill module at submit time.
    // The preview shows which standard fields we'll attempt to fill.
    const previewFields: BrowserSubmissionPlan['fields'] = [];
    if (profile.name) previewFields.push({ name: 'name', type: 'text', label: 'Name', required: true, value: profile.name as string, source: 'defaults' });
    if (profile.email) previewFields.push({ name: 'email', type: 'text', label: 'Email', required: true, value: profile.email as string, source: 'defaults' });
    if (profile.phone) previewFields.push({ name: 'phone', type: 'text', label: 'Phone', required: false, value: profile.phone as string, source: 'defaults' });
    if (profile.linkedin) previewFields.push({ name: 'linkedin', type: 'text', label: 'LinkedIn', required: false, value: profile.linkedin as string, source: 'defaults' });
    if (profile.location) previewFields.push({ name: 'location', type: 'text', label: 'Location', required: false, value: profile.location as string, source: 'defaults' });
    if (pdf) previewFields.push({ name: 'resume', type: 'file', label: 'Resume', required: true, value: { filename: pdf.filename, mimeType: 'application/pdf', sizeBytes: pdf.bytes.length }, source: 'defaults' });
    if (coverLetterMd) previewFields.push({ name: 'cover_letter', type: 'textarea', label: 'Cover Letter', required: false, value: coverLetterMd.slice(0, 200) + '…', source: 'defaults' });

    const plan: BrowserSubmissionPlan = {
      strategy: 'browser',
      // Navigate to the page that actually HAS the form. Ashby (and boards like it) serve a
      // description at the job URL and put the application on /application — sending the autofill
      // assistant to the bare URL opened a browser window with nothing to fill, which reads as a
      // broken feature. Measured: bare Ashby URL = 0 inputs, /application = 8-16.
      url: applicationUrl(job.url),
      jobTitle: job.title,
      company: job.company,
      fields: previewFields,
      attachments: {
        resume: pdf ? { filename: pdf.filename, mimeType: 'application/pdf', bytes: pdf.bytes } : undefined,
        coverLetter: coverLetterMd ? {
          filename: coverLetterFilename,
          mimeType: 'text/plain',
          bytes: new TextEncoder().encode(coverLetterMd),
        } : undefined,
      },
    };
    return { ok: true, plan, strategy: 'browser', warnings, resumeSource: resumeSource === 'original' && hasOriginal ? 'original' : 'tailored', resumeSourceAvailable: { original: hasOriginal }, hasTailored };
  }

  if (strategyMatch.strategy === 'ashby' && strategyMatch.ashby) {
    try {
      const plan = await buildAshbyPlan({
        company: strategyMatch.ashby.company,
        jobPostingId: strategyMatch.ashby.jobPostingId,
        jobTitle: job.title,
        jobLocation: job.location,
        jobDescription: job.description,
        profile,
        defaults: config.defaults,
        resumePdfBuf: pdf.bytes,
        resumeFilename: pdf.filename,
        coverLetterText: coverLetterMd || undefined,
        coverLetterFilename,
      });
      return { ok: true, plan, strategy: 'ashby', warnings, resumeSource: resumeSource === 'original' && hasOriginal ? 'original' : 'tailored', resumeSourceAvailable: { original: hasOriginal }, hasTailored };
    } catch (e) {
      return { ok: false, strategy: 'ashby', warnings, error: `Ashby plan build failed: ${(e as Error).message}` };
    }
  }

  if (strategyMatch.strategy === 'linkedin') {
    // No schema fetch — the LinkedIn adapter detects the Easy Apply modal at runtime.
    // The preview shows which standard fields we'll attempt to fill from profile.
    const previewFields: LinkedInSubmissionPlan['fields'] = [];
    if (profile.name) previewFields.push({ name: 'name', type: 'text', label: 'Name', required: true, value: profile.name as string });
    if (profile.email) previewFields.push({ name: 'email', type: 'text', label: 'Email', required: true, value: profile.email as string });
    if (profile.phone) previewFields.push({ name: 'phone', type: 'text', label: 'Phone', required: false, value: profile.phone as string });
    if (profile.linkedin) previewFields.push({ name: 'linkedin', type: 'text', label: 'LinkedIn', required: false, value: profile.linkedin as string });
    if (profile.location) previewFields.push({ name: 'location', type: 'text', label: 'Location', required: false, value: profile.location as string });
    if (pdf) previewFields.push({ name: 'resume', type: 'file', label: 'Resume', required: true, value: pdf.filename });
    if (coverLetterMd) previewFields.push({ name: 'cover_letter', type: 'textarea', label: 'Cover Letter', required: false, value: coverLetterMd.slice(0, 200) + '…' });

    const plan: LinkedInSubmissionPlan = {
      strategy: 'linkedin',
      url: job.url,
      jobTitle: job.title,
      company: job.company,
      fields: previewFields,
      attachments: {
        resume: pdf ? { filename: pdf.filename, mimeType: 'application/pdf', bytes: pdf.bytes } : undefined,
        coverLetter: coverLetterMd ? {
          filename: coverLetterFilename,
          mimeType: 'text/plain',
          bytes: new TextEncoder().encode(coverLetterMd),
        } : undefined,
      },
    };
    return { ok: true, plan, strategy: 'linkedin', warnings, resumeSource: resumeSource === 'original' && hasOriginal ? 'original' : 'tailored', resumeSourceAvailable: { original: hasOriginal }, hasTailored };
  }

  if (strategyMatch.strategy === 'naukri') {
    const previewFields: NaukriSubmissionPlan['fields'] = [];
    if (profile.name) previewFields.push({ name: 'name', type: 'text', label: 'Name', required: true, value: profile.name as string });
    if (profile.email) previewFields.push({ name: 'email', type: 'text', label: 'Email', required: true, value: profile.email as string });
    if (profile.phone) previewFields.push({ name: 'phone', type: 'text', label: 'Phone', required: false, value: profile.phone as string });
    if (profile.location) previewFields.push({ name: 'location', type: 'text', label: 'Location', required: false, value: profile.location as string });
    if (pdf) previewFields.push({ name: 'resume', type: 'file', label: 'Resume', required: true, value: pdf.filename });
    if (coverLetterMd) previewFields.push({ name: 'cover_letter', type: 'textarea', label: 'Cover Letter', required: false, value: coverLetterMd.slice(0, 200) + '…' });

    const plan: NaukriSubmissionPlan = {
      strategy: 'naukri',
      url: job.url,
      jobTitle: job.title,
      company: job.company,
      fields: previewFields,
      attachments: {
        resume: pdf ? { filename: pdf.filename, mimeType: 'application/pdf', bytes: pdf.bytes } : undefined,
        coverLetter: coverLetterMd ? {
          filename: coverLetterFilename,
          mimeType: 'text/plain',
          bytes: new TextEncoder().encode(coverLetterMd),
        } : undefined,
      },
    };
    return { ok: true, plan, strategy: 'naukri', warnings, resumeSource: resumeSource === 'original' && hasOriginal ? 'original' : 'tailored', resumeSourceAvailable: { original: hasOriginal }, hasTailored };
  }

  return { ok: false, strategy: strategyMatch.strategy, warnings, error: 'Unreachable code path' };
}

// Rate-limit check — call before any actual submission.
export function checkRateLimit(strategy: SubmissionStrategy): { ok: boolean; reason?: string; counts: { today: number; thisHour: number } } {
  const config = getApplyConfig();

  // Both sides of the comparison MUST be in SQLite's own datetime format.
  //
  // This used to bound the window with `new Date(...).toISOString()`, which produces
  // "2026-08-29T17:22:33.000Z" — a 'T' separator — while `attempted_at` is
  // `DATETIME DEFAULT CURRENT_TIMESTAMP`, i.e. "2026-08-29 18:22:33" with a SPACE. TEXT comparison
  // hits character 11 and compares ' ' (32) against 'T' (84), so every row recorded on the same
  // date sorted BELOW the threshold and was not counted.
  //
  // Effect: the HOURLY cap counted 0 forever and could never fire. The daily cap appeared to work
  // only by accident — its window starts on the previous DATE, so the difference showed up at
  // character 9 before the separator was ever reached. Measured: 3 successes inserted seconds
  // before the check produced `thisHour = 0`.
  //
  // `datetime('now', ...)` is evaluated by SQLite in the same format and timezone (UTC) as
  // CURRENT_TIMESTAMP, so the comparison is now like-for-like.
  const todayRow = db
    .prepare(`SELECT COUNT(*) as n FROM apply_audit WHERE attempted_at >= datetime('now', '-1 day') AND status = 'success'`)
    .get() as { n: number };
  const hourRow = db
    .prepare(`SELECT COUNT(*) as n FROM apply_audit WHERE attempted_at >= datetime('now', '-1 hour') AND status = 'success'`)
    .get() as { n: number };
  const counts = { today: todayRow.n, thisHour: hourRow.n };

  if (todayRow.n >= config.rateLimit.perDay) {
    return { ok: false, reason: `Daily cap (${config.rateLimit.perDay}) reached`, counts };
  }
  if (hourRow.n >= config.rateLimit.perHour) {
    return { ok: false, reason: `Hourly cap (${config.rateLimit.perHour}) reached — wait`, counts };
  }
  return { ok: true, counts };
}
