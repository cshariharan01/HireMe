import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { createHash } from 'crypto';
import { detectAts } from '@/lib/discovery/ats-detect';
import { pullBoard, type NormalizedJob } from '@/lib/discovery/ats-pull';
import { crawlCareersPage } from '@/lib/discovery/crawl';
import { classifyJob } from '@/lib/job-classifier';
import { isDomainPriority } from '@/lib/ontology';
import { isSeniorRelevant } from '@/lib/seniority';

const SOURCE = 'company';

// POST /api/jobs/discover  { input: "<company name or careers URL>" }
// Detects the ATS and pulls the whole board (or crawls the page), inserting all senior/
// healthcare-relevant roles. Leaves embedding NULL — run `npm run embed` to make them
// matchable (same as the other bulk sources; a full board can be 100+ jobs).
export async function POST(request: NextRequest) {
  try {
    const { input } = await request.json();
    if (!input || typeof input !== 'string' || !input.trim()) {
      return NextResponse.json({ error: 'Provide a company name or careers URL' }, { status: 400 });
    }
    const seed = input.trim();
    const isUrl = /^https?:\/\//i.test(seed);

    let jobs: NormalizedJob[] = [];
    let via = 'crawl';
    const match = await detectAts(seed);
    if (match && match.supported) {
      jobs = await pullBoard(match, isUrl ? undefined : seed);
      via = `${match.ats}/${match.slug}`;
    } else {
      const crawlUrl = isUrl ? seed : match ? `https://${match.slug}.com/careers` : null;
      if (!crawlUrl) {
        return NextResponse.json({ error: 'No ATS detected and no URL to crawl. Paste the careers page URL directly.' }, { status: 422 });
      }
      jobs = await crawlCareersPage(crawlUrl, { company: isUrl ? undefined : seed });
      via = `crawl:${crawlUrl}`;
    }

    const upsert = db.prepare(`
      INSERT INTO job_postings (source, company, title, location, description, url, domain_priority, remote_policy, visa_sponsorship, relocation_offered, dedup_hash, posted_at, last_seen_at, source_present)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
      ON CONFLICT(dedup_hash) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP, source_present = 1, posted_at = COALESCE(excluded.posted_at, posted_at)
    `);

    // Experience-aware seniority gate: keep junior/entry roles when the resume is early-career
    // (mirrors resolveAllowJunior in scripts/shared/profile-level.ts). Defaults to false (senior).
    let allowJunior = false;
    try {
      const prow = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as { parsed_json: string } | undefined;
      if (prow) {
        const p = JSON.parse(prow.parsed_json);
        allowJunior = typeof p.yearsOfExperience === 'number'
          ? p.yearsOfExperience < 6
          : /\b(junior|jr|entry|associate|fresher|graduate|trainee|intern|mid)\b/i.test(String(p.seniority || p.title || ''));
      }
    } catch { /* default false */ }

    let added = 0;
    let kept = 0;
    for (const job of jobs) {
      const title = job.title || '';
      const description = (job.description || '').slice(0, 8000);
      if (!title || !job.url) continue;
      const domainPri = isDomainPriority(title + ' ' + description);
      if (!domainPri && !isSeniorRelevant(title, { allowJunior })) continue;
      kept++;
      const cls = classifyJob(title, description, job.location || '');
      const hash = createHash('sha256').update(SOURCE + job.company + title + (job.location || '')).digest('hex');
      const res = upsert.run(
        SOURCE, job.company, title, job.location || '', description, job.url,
        domainPri ? 1 : 0, cls.remote_policy, cls.visa_sponsorship ? 1 : 0, cls.relocation_offered ? 1 : 0,
        hash, job.posted_at,
      );
      if (res.changes > 0) added++;
    }

    return NextResponse.json({
      success: true,
      via,
      found: jobs.length,
      kept,
      added,
      needsEmbedding: added > 0,
      message: jobs.length === 0
        ? 'No jobs found. If this is a custom careers page, paste the exact listings URL.'
        : `Found ${jobs.length}, kept ${kept} relevant, ${added} new. Run "npm run embed" to make them matchable.`,
    });
  } catch (error) {
    console.error('Discover error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Discovery failed' }, { status: 500 });
  }
}
