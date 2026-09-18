import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { extractPostingFacts } from '@/lib/posting-facts';
import { getRankedMatches, getRankedMatchById } from '@/lib/matches';

interface JobRow {
  id: number;
  source: string;
  company: string;
  title: string;
  location: string;
  description: string;
  description_formatted: string | null;
  url: string;
  domain_priority: number;
  ingested_at: string;
  posted_at?: string | null;
}

interface ApplicationRow {
  status: string;
  cover_letter: string;
  resume_variant: string;
  notes: string;
  applied_at: string;
  applied_date: string | null;
  recruiter_name: string | null;
  recruiter_contact: string | null;
  next_follow_up_at: string | null;
  last_status_change_at: string | null;
}

export async function GET(request: NextRequest, props: { params: Promise<{ jobId: string }> }) {
  const params = await props.params;
  try {
    const jobId = parseInt(params.jobId);

    const job = db.prepare('SELECT * FROM job_postings WHERE id = ?').get(jobId) as JobRow | undefined;
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Score breakdown comes from the shared ranked-match cache.
    //
    // IMPORTANT: read the DEFAULT pool first — the same options /api/matches uses. `retrieval` is
    // normalised against the best observed RRF *within a pool*, so the identical job scores
    // differently in a differently-filtered pool. Reading only the all-inclusive view made the
    // detail header show 78 for a job the list showed as 84, which is exactly the kind of
    // inconsistency this scoring work exists to remove.
    //
    // Fall back to the all-inclusive pool so a hidden / expired / already-applied job (e.g. opened
    // from /tracker) still resolves — its score then comes from that pool, which is the only one
    // it appears in.
    // Map lookup against the memoised payload — no 1.6MB parse, no linear scan over ~1200 rows.
    let matchResult = getRankedMatchById({ includeHidden: false, includeExpired: false }, jobId);
    if (!matchResult) {
      // cachedOnly: this pool is only needed for a hidden/expired/applied job, and computing it
      // synchronously added a consistent 4.5s to the detail route. If it isn't warm yet the page
      // renders without a fit score and the pool fills in the background.
      matchResult = getRankedMatchById(
        { includeHidden: true, includeExpired: true, includeApplied: true, cachedOnly: true },
        jobId,
      );
    }

    const application = db.prepare(
      `SELECT status, cover_letter, resume_variant, notes, applied_at,
              applied_date, recruiter_name, recruiter_contact, next_follow_up_at, last_status_change_at
       FROM my_applications WHERE job_id = ?`
    ).get(jobId) as ApplicationRow | undefined;

    const facts = extractPostingFacts(job.description || '', job.location || '', job.title || '', job.url || '');

    return NextResponse.json({
      job: {
        id: job.id,
        source: job.source,
        company: job.company,
        title: job.title,
        location: job.location,
        description: job.description,
        descriptionFormatted: job.description_formatted,
        url: job.url,
        domainPriority: job.domain_priority,
        ingestedAt: job.ingested_at,
        postedAt: job.posted_at || null,
        facts,
      },
      // Pass the whole ranked match through. It used to hand-pick four fields, which silently
      // dropped `score`, `reasons`, `skillFit`, `ageDays` and `variants` — so the detail view
      // could not show the fit score or WHY the job matched.
      match: matchResult ?? null,
      application: application || null,
    });
  } catch (error) {
    console.error('Job detail error:', error);
    return NextResponse.json({ error: 'Failed to fetch job details' }, { status: 500 });
  }
}
