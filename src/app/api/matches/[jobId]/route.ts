import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { extractPostingFacts } from '@/lib/posting-facts';
import { getRankedMatches, getRankedMatchById } from '@/lib/matches';
import { getActiveOwnerId } from '@/lib/apply/screening-owner';

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
  try {
    const params = props?.params ? await props.params : (props as any)?.params;
    const rawId = params?.jobId ?? (params as any)?.id;
    const jobId = parseInt(rawId, 10);
    if (!jobId || isNaN(jobId)) {
      return NextResponse.json({ error: 'Invalid or missing jobId' }, { status: 400 });
    }

    const job = db.prepare('SELECT * FROM job_postings WHERE id = ?').get(jobId) as JobRow | undefined;
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Score breakdown comes from the shared ranked-match cache.
    // Wrap in try/catch so a match cache anomaly never blocks basic job detail display.
    let matchResult: any = null;
    try {
      matchResult = getRankedMatchById({ includeHidden: false, includeExpired: false }, jobId);
      if (!matchResult) {
        matchResult = getRankedMatchById(
          { includeHidden: true, includeExpired: true, includeApplied: true, cachedOnly: true },
          jobId,
        );
      }
    } catch (e) {
      console.warn('[api/matches/[jobId]] match lookup error:', e);
    }

    const activeOwner = getActiveOwnerId();
    const application = db.prepare(
      `SELECT status, cover_letter, resume_variant, notes, applied_at,
              applied_date, recruiter_name, recruiter_contact, next_follow_up_at, last_status_change_at
       FROM my_applications WHERE job_id = ? AND (owner_id = ? OR (owner_id IS NULL AND ? = 'default'))`
    ).get(jobId, activeOwner, activeOwner) as ApplicationRow | undefined;

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
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Failed to fetch job details (${msg})` }, { status: 500 });
  }
}
