import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { invalidateMatchCache } from '@/lib/matches';

// POST /api/jobs/[id]/hide   — set hidden_at = now
// DELETE /api/jobs/[id]/hide — clear hidden_at (unhide)
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const jobId = parseInt(params.id, 10);
    const result = db
      .prepare('UPDATE job_postings SET hidden_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(jobId);
    if (result.changes === 0) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    invalidateMatchCache(jobId, { hidden: true });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to hide' },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const jobId = parseInt(params.id, 10);
    const result = db
      .prepare('UPDATE job_postings SET hidden_at = NULL WHERE id = ?')
      .run(jobId);
    if (result.changes === 0) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    invalidateMatchCache(jobId, { hidden: false });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to unhide' },
      { status: 500 }
    );
  }
}
