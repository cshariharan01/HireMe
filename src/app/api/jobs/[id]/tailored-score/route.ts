import { NextRequest, NextResponse } from 'next/server';
import { calculateAndStoreTailoredScore } from '@/lib/tailored-score';

export const runtime = 'nodejs';

/**
 * POST /api/jobs/[id]/tailored-score — score this job against the AI-tailored résumé.
 *
 * Scores the job against the candidate's tailored resume (either markdown variant or LaTeX tex),
 * persists the score into `my_applications` and `job_documents`, and returns the tailored score,
 * default score, delta, and full match breakdown.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const jobId = parseInt(id, 10) || 0;

  let explicitText = '';
  try {
    const body = (await request.json()) as { resumeText?: unknown };
    if (typeof body.resumeText === 'string' && body.resumeText.trim()) {
      explicitText = body.resumeText.trim();
    }
  } catch {
    /* no body */
  }

  const result = await calculateAndStoreTailoredScore(jobId, explicitText);
  if (!result) {
    return NextResponse.json(
      { error: 'No AI-tailored résumé exists for this job, or scoring failed.' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    score: result.score,
    defaultScore: result.defaultScore,
    delta: result.delta,
  });
}

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  return POST(request, props);
}