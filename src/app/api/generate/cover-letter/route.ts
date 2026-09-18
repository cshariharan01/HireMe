import { NextRequest, NextResponse } from 'next/server';
import { saveJobDocument } from '@/lib/apply/documents';
import db from '@/lib/db';
import { generateCoverLetter } from '@/lib/llm';

interface JobRow {
  id: number;
  company: string;
  title: string;
  description: string;
}

interface ProfileRow {
  parsed_json: string;
}

export async function POST(request: NextRequest) {
  try {
    const { jobId } = await request.json();

    const job = db.prepare('SELECT id, company, title, description FROM job_postings WHERE id = ?')
      .get(jobId) as JobRow | undefined;

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const profile = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1')
      .get() as ProfileRow | undefined;

    if (!profile) {
      return NextResponse.json({ error: 'No resume uploaded' }, { status: 400 });
    }

    const resumeJson = JSON.parse(profile.parsed_json);
    const result = await generateCoverLetter(
      resumeJson,
      job.title,
      job.company,
      job.description || '',
      // A human is waiting on this button — fail fast instead of a 4-minute stall.
      { interactive: true },
    );
    const coverLetter = result.text;

    // Cache WITHOUT fabricating an application. Inserting a row with status='applied'
    // here meant generating a document removed the job from the match list, the digest
    // and every rating path. `saveJobDocument` writes to the application only if the user
    // really applied; otherwise it goes to the `job_documents` cache.
    saveJobDocument(jobId, 'cover_letter', coverLetter);

    return NextResponse.json({ coverLetter, coverage: result.coverage });
  } catch (error) {
    console.error('Cover letter error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate cover letter' },
      { status: 500 }
    );
  }
}
