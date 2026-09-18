import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { invalidateProviderCache } from '@/lib/llm';

// POST /api/providers/[id]/activate — set this provider active, deactivate all others.
// POST /api/providers/[id]/activate?clear=1 — deactivate this one (clear=1) returning to env-based selection.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id);
    const url = new URL(req.url);
    const clear = url.searchParams.get('clear') === '1';

    if (clear) {
      const result = db.prepare('UPDATE llm_providers SET is_active = 0 WHERE id = ?').run(id);
      if (result.changes === 0) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
      invalidateProviderCache();
      return NextResponse.json({ success: true, active: false });
    }

    const tx = db.transaction(() => {
      db.prepare('UPDATE llm_providers SET is_active = 0').run();
      const result = db.prepare('UPDATE llm_providers SET is_active = 1 WHERE id = ?').run(id);
      if (result.changes === 0) throw new Error('Provider not found');
    });
    tx();
    invalidateProviderCache();
    return NextResponse.json({ success: true, active: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed';
    if (msg === 'Provider not found') return NextResponse.json({ error: msg }, { status: 404 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
