import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { setActiveResume } from '@/lib/resumes';

// DELETE /api/resumes/[id] — remove a resume from the library. If it was active, the most
// recent remaining resume becomes active (and is mirrored into my_profile). If it was the last
// one, my_profile is cleared so the app shows "no resume".
export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id, 10);
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const row = db.prepare('SELECT id, is_active FROM resumes WHERE id = ?').get(id) as { id: number; is_active: number } | undefined;
    if (!row) return NextResponse.json({ error: 'Resume not found' }, { status: 404 });

    db.prepare('DELETE FROM resumes WHERE id = ?').run(id);

    let newActiveId: number | null = null;
    if (row.is_active) {
      const next = db.prepare('SELECT id FROM resumes ORDER BY updated_at DESC LIMIT 1').get() as { id: number } | undefined;
      if (next) {
        setActiveResume(next.id);
        newActiveId = next.id;
      } else {
        // No resumes left — clear the active profile so matches/generation show "no resume".
        db.prepare('UPDATE my_profile SET raw_text = NULL, parsed_json = NULL, embedding = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run();
      }
    }

    return NextResponse.json({ success: true, newActiveId });
  } catch (error) {
    console.error('Delete resume error:', error);
    return NextResponse.json({ error: 'Failed to delete resume' }, { status: 500 });
  }
}
