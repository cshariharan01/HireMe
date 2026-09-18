import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { evaluateJob, getActiveProviderName, type JobEvaluation } from '@/lib/llm';

interface JobRow {
  id: number;
  title: string;
  company: string;
  location: string;
  description: string;
}
interface ProfileRow {
  parsed_json: string;
}
interface EvalRow {
  overall_score: number;
  recommendation: string;
  cv_alignment_score: number;
  cv_alignment_notes: string;
  north_star_fit_score: number;
  north_star_fit_notes: string;
  compensation_score: number;
  compensation_notes: string;
  culture_score: number;
  culture_notes: string;
  strategy_notes: string;
  computed_at: string;
  provider: string;
}

// POST /api/jobs/[id]/evaluate
// Returns the LLM evaluation. Cached per-job in job_evaluations.
// Query param ?refresh=1 forces re-evaluation.
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const jobId = parseInt(params.id);
    const url = new URL(req.url);
    // ONE param, two jobs. This used to be two: `refresh=1` bypassed the cache and a SEPARATE
    // `force=1` overrode the applied-job guard. The detail panel only ever sent `refresh=1`, so
    // re-rating an applied job always 409'd and the user was shown the raw API string
    // "Add ?force=1 to evaluate anyway". `refresh` is now the canonical name and `force` is kept
    // as an accepted alias so existing links and scripts keep working.
    const force =
      url.searchParams.get('refresh') === '1' || url.searchParams.get('force') === '1';
    // cacheOnly: return the cached evaluation if present, else null — never run the LLM. Used by
    // the detail panel's auto-load so opening a job doesn't silently trigger an LLM call.
    const cacheOnly = url.searchParams.get('cacheOnly') === '1';

    if (!force) {
      const cached = db
        .prepare('SELECT * FROM job_evaluations WHERE job_id = ?')
        .get(jobId) as EvalRow | undefined;
      if (cached) {
        return NextResponse.json({ evaluation: cached, cached: true });
      }
      if (cacheOnly) {
        return NextResponse.json({ evaluation: null, cached: false });
      }
    }

    const job = db
      .prepare('SELECT id, title, company, location, description FROM job_postings WHERE id = ?')
      .get(jobId) as JobRow | undefined;
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    // Already applied? Don't spend LLM quota re-rating a decision that's been made. `force=1`
    // exists for the rare case of wanting a fresh read on a job mid-process (e.g. before an
    // interview), which is why this is a guard and not a hard block.
    const alreadyApplied = db
      .prepare('SELECT 1 FROM my_applications WHERE job_id = ? LIMIT 1')
      .get(jobId);
    if (alreadyApplied && !force) {
      return NextResponse.json(
        {
          error: "You've already applied to this job, so it wasn't re-rated.",
          skipped: 'applied',
        },
        { status: 409 },
      );
    }

    const profile = db
      .prepare('SELECT parsed_json FROM my_profile WHERE id = 1')
      .get() as ProfileRow | undefined;
    if (!profile) return NextResponse.json({ error: 'No resume uploaded' }, { status: 400 });

    const resumeJson = JSON.parse(profile.parsed_json);
    const evaluation: JobEvaluation = await evaluateJob(
      resumeJson,
      job.title,
      job.company,
      job.location || '',
      job.description || ''
    );

    const provider = getActiveProviderName();

    // Never persist a hollow evaluation. A row with no score, or with no prose behind it, reads
    // as authoritative in the UI AND stops the job being re-evaluated (both this route and
    // evaluate-top skip jobs that already have a row) — so a bad row is stickier than no row.
    // `evaluateJob` already rejects these upstream; this is the boundary guard, because 6 such
    // rows reached the table on 2026-07-17/18 before that existed.
    const hasProse = [
      evaluation.cv_alignment_notes,
      evaluation.north_star_fit_notes,
      evaluation.compensation_notes,
      evaluation.culture_notes,
      evaluation.strategy_notes,
    ].some((n) => (n || '').trim().length > 0);
    if (!Number.isFinite(evaluation.overall_score) || !hasProse) {
      return NextResponse.json(
        { error: `${provider} returned an evaluation with no score or no reasoning — not saved, try again` },
        { status: 502 },
      );
    }

    db.prepare(
      `INSERT INTO job_evaluations (job_id, provider, overall_score, recommendation,
         cv_alignment_score, cv_alignment_notes, north_star_fit_score, north_star_fit_notes,
         compensation_score, compensation_notes, culture_score, culture_notes, strategy_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         provider = excluded.provider,
         computed_at = CURRENT_TIMESTAMP,
         overall_score = excluded.overall_score,
         recommendation = excluded.recommendation,
         cv_alignment_score = excluded.cv_alignment_score,
         cv_alignment_notes = excluded.cv_alignment_notes,
         north_star_fit_score = excluded.north_star_fit_score,
         north_star_fit_notes = excluded.north_star_fit_notes,
         compensation_score = excluded.compensation_score,
         compensation_notes = excluded.compensation_notes,
         culture_score = excluded.culture_score,
         culture_notes = excluded.culture_notes,
         strategy_notes = excluded.strategy_notes`
    ).run(
      jobId,
      provider,
      evaluation.overall_score,
      evaluation.recommendation,
      evaluation.cv_alignment_score,
      evaluation.cv_alignment_notes,
      evaluation.north_star_fit_score,
      evaluation.north_star_fit_notes,
      evaluation.compensation_score,
      evaluation.compensation_notes,
      evaluation.culture_score,
      evaluation.culture_notes,
      evaluation.strategy_notes
    );

    return NextResponse.json({ evaluation, cached: false });
  } catch (error) {
    console.error('Evaluation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to evaluate' },
      { status: 500 }
    );
  }
}
