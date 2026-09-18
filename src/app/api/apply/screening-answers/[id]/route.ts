import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

/**
 * Edit or delete one stored screening answer.
 *
 * Editing matters more than it looks: the answer is keyed by a hash of the QUESTION, so a bad
 * answer is reused on every future application that asks the same thing. `question_hash` is
 * deliberately left untouched on edit — the question hasn't changed, only our answer to it.
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id, 10);
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

    const body = (await req.json()) as { answer?: string };
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (!answer) return NextResponse.json({ error: 'Answer cannot be empty' }, { status: 400 });

    const res = db.prepare('UPDATE screening_answers SET answer = ? WHERE id = ?').run(answer, id);
    if (res.changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id, 10);
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
    const res = db.prepare('DELETE FROM screening_answers WHERE id = ?').run(id);
    if (res.changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Deleting just clears the cache — the next application that asks this question will answer it
    // fresh from the profile / LLM rather than reusing a stale value.
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  }
}
