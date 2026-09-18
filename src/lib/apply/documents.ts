import db from '@/lib/db';

/**
 * Read/write cache for generated cover letters and resume variants.
 *
 * These used to be cached directly in `my_applications`, creating a row with `status = 'applied'`
 * when none existed — so generating a preview fabricated an application. Once the matcher began
 * excluding applied jobs, that quietly removed the job from the list the app exists to produce.
 *
 * The rule now: an application row is written ONLY by an actual application. If one already exists
 * (the user really applied), keep writing there so the tracker shows what was sent; otherwise the
 * document goes to `job_documents`, which is a pure cache.
 */

export interface JobDocuments {
  coverLetter: string | null;
  resumeVariant: string | null;
  resumeTex: string | null;
  tailoredScore: number | null;
  defaultScore: number | null;
}

/** Prefer what was actually sent (the application) over the speculative cache. */
export function readJobDocuments(jobId: number): JobDocuments {
  const app = db
    .prepare('SELECT cover_letter, resume_variant, resume_tex, tailored_score, default_score FROM my_applications WHERE job_id = ?')
    .get(jobId) as { cover_letter: string | null; resume_variant: string | null; resume_tex: string | null; tailored_score: number | null; default_score: number | null } | undefined;
  const cached = db
    .prepare('SELECT cover_letter, resume_variant, resume_tex, tailored_score, default_score FROM job_documents WHERE job_id = ?')
    .get(jobId) as { cover_letter: string | null; resume_variant: string | null; resume_tex: string | null; tailored_score: number | null; default_score: number | null } | undefined;

  return {
    coverLetter: app?.cover_letter ?? cached?.cover_letter ?? null,
    resumeVariant: app?.resume_variant ?? cached?.resume_variant ?? null,
    resumeTex: app?.resume_tex ?? cached?.resume_tex ?? null,
    tailoredScore: app?.tailored_score ?? cached?.tailored_score ?? null,
    defaultScore: app?.default_score ?? cached?.default_score ?? null,
  };
}

/**
 * Cache a generated document WITHOUT ever creating an application.
 *
 * If the user has genuinely applied to this job, the document belongs on that record. Otherwise it
 * is speculative and belongs in the cache — never in `my_applications`.
 */
export function saveJobDocument(
  jobId: number,
  field: 'cover_letter' | 'resume_variant' | 'resume_tex',
  value: string,
): void {
  const hasApplication = db.prepare('SELECT 1 FROM my_applications WHERE job_id = ? LIMIT 1').get(jobId);
  if (hasApplication) {
    db.prepare(`UPDATE my_applications SET ${field} = ? WHERE job_id = ?`).run(value, jobId);
    if (field === 'resume_variant' || field === 'resume_tex') {
      import('@/lib/tailored-score')
        .then(({ calculateAndStoreTailoredScore }) => calculateAndStoreTailoredScore(jobId, value))
        .catch(() => {});
    }
    return;
  }
  db.prepare(
    `INSERT INTO job_documents (job_id, ${field}, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(job_id) DO UPDATE SET ${field} = excluded.${field}, updated_at = CURRENT_TIMESTAMP`,
  ).run(jobId, value);

  if (field === 'resume_variant' || field === 'resume_tex') {
    // Asynchronously pre-compute fit score against JD so it's instantly ready when applied
    import('@/lib/tailored-score')
      .then(({ calculateAndStoreTailoredScore }) => calculateAndStoreTailoredScore(jobId, value))
      .catch(() => {});
  }
}

/**
 * Move any cached documents onto the application record once a real application exists, so the
 * tracker shows exactly what was sent and the cache doesn't hold a stale duplicate.
 */
export function promoteDocumentsToApplication(jobId: number): void {
  const cached = db
    .prepare('SELECT cover_letter, resume_variant, resume_tex, tailored_score, default_score FROM job_documents WHERE job_id = ?')
    .get(jobId) as { cover_letter: string | null; resume_variant: string | null; resume_tex: string | null; tailored_score: number | null; default_score: number | null } | undefined;
  if (!cached) return;
  db.prepare(
    `UPDATE my_applications
        SET cover_letter   = COALESCE(cover_letter, ?),
            resume_variant = COALESCE(resume_variant, ?),
            resume_tex     = COALESCE(resume_tex, ?),
            tailored_score = COALESCE(tailored_score, ?),
            default_score  = COALESCE(default_score, ?)
      WHERE job_id = ?`,
  ).run(cached.cover_letter, cached.resume_variant, cached.resume_tex, cached.tailored_score, cached.default_score, jobId);
  db.prepare('DELETE FROM job_documents WHERE job_id = ?').run(jobId);
}
