import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

const ALLOWED_PATCH = ['display_name', 'model', 'api_key', 'base_url'];

// PATCH /api/providers/[id] — update fields
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id);
    const body = await req.json();
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const k of ALLOWED_PATCH) {
      if (k in body) {
        sets.push(`${k} = ?`);
        values.push(body[k] ?? null);
      }
    }
    if (sets.length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }
    values.push(id);
    const result = db.prepare(`UPDATE llm_providers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}

// DELETE /api/providers/[id]
export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id);
    const result = db.prepare('DELETE FROM llm_providers WHERE id = ?').run(id);
    if (result.changes === 0) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}
