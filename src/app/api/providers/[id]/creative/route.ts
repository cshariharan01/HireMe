import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { invalidateProviderCache } from '@/lib/llm';

// POST /api/providers/[id]/creative — mark this provider as the creative-lane target.
// At most one provider should hold the flag, so we clear it on all others atomically.
// DELETE on the same path → unset the flag (revert to default Gemini Pro→Flash path).
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id, 10);
    if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const exists = db.prepare('SELECT id FROM llm_providers WHERE id = ?').get(id);
    if (!exists) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const tx = db.transaction((targetId: number) => {
      db.prepare('UPDATE llm_providers SET is_creative = 0 WHERE is_creative = 1').run();
      db.prepare('UPDATE llm_providers SET is_creative = 1 WHERE id = ?').run(targetId);
    });
    tx(id);
    invalidateProviderCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id, 10);
    if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    db.prepare('UPDATE llm_providers SET is_creative = 0 WHERE id = ?').run(id);
    invalidateProviderCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}
