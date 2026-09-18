import { NextResponse } from 'next/server';
import db from '@/lib/db';

// DELETE /api/outcomes/[id] — remove a tracked application by row id.
// The job_posting itself is left intact; only the my_applications row is dropped.
export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id, 10);
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }
    const app = db.prepare('SELECT job_id FROM my_applications WHERE id = ?').get(id) as { job_id: number } | undefined;
    const result = db.prepare('DELETE FROM my_applications WHERE id = ?').run(id);
    if (result.changes === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (app?.job_id) {
      try {
        const { invalidateMatchCache } = await import('@/lib/matches');
        invalidateMatchCache(app.job_id, { applied: false });
      } catch {}
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete application error:', error);
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
  }
}
