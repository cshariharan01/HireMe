import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { formatJobDescription } from '@/lib/llm';

interface JobRow {
  id: number;
  title: string;
  company: string;
  description: string;
  description_formatted: string | null;
}

// POST /api/jobs/[id]/format
// Returns the LLM-formatted Markdown for a job description.
// Caches in description_formatted column — first call ~5-10s (one Gemini round-trip),
// subsequent calls instant.
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const jobId = parseInt(params.id);
    const job = db
      .prepare('SELECT id, title, company, description, description_formatted FROM job_postings WHERE id = ?')
      .get(jobId) as JobRow | undefined;

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    if (job.description_formatted !== null) {
      return NextResponse.json({ formatted: job.description_formatted, cached: true });
    }

    // Skip Gemini call for empty/near-empty descriptions; cache the empty result.
    const raw = (job.description || '').trim();
    if (raw.length < 100) {
      db.prepare('UPDATE job_postings SET description_formatted = ? WHERE id = ?').run(raw, jobId);
      return NextResponse.json({ formatted: raw, cached: false, skipped: true });
    }

    const formatted = await formatJobDescription(raw, job.title, job.company);
    db.prepare('UPDATE job_postings SET description_formatted = ? WHERE id = ?').run(formatted, jobId);
    return NextResponse.json({ formatted, cached: false });
  } catch (error) {
    console.error('JD format error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to format' },
      { status: 500 }
    );
  }
}
