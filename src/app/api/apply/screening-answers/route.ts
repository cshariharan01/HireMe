import { NextResponse } from 'next/server';
import db from '@/lib/db';

/**
 * Stored screening answers — the ones auto-apply reuses across postings.
 *
 * These had NO user interface at all. `screening_answers` accumulated answers keyed by a hash of
 * the question text and reused them forever, so a single wrong answer (say the sponsorship
 * question) silently propagated to every future application with no way to see or correct it.
 * These routes back the "Screening answers" section in /settings.
 */
export interface ScreeningAnswerRow {
  id: number;
  question: string;
  answer: string;
  category: string | null;
  used_count: number;
  last_used_at: string;
}

export async function GET() {
  try {
    const answers = db
      .prepare(
        `SELECT id, question, answer, category, used_count, last_used_at
         FROM screening_answers
         ORDER BY used_count DESC, last_used_at DESC`,
      )
      .all() as ScreeningAnswerRow[];
    return NextResponse.json({ answers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  }
}
