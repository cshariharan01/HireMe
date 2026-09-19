import { NextResponse } from 'next/server';
import db from '@/lib/db';

// GET /api/profile/apply-mode — returns the current apply mode and score threshold
export async function GET() {
  try {
    const mode = (db.prepare("SELECT value FROM user_settings WHERE key = 'apply_mode'").get() as { value: string } | undefined)?.value ?? 'smart';
    const threshold = parseInt((db.prepare("SELECT value FROM user_settings WHERE key = 'score_threshold'").get() as { value: string } | undefined)?.value ?? '60', 10);
    return NextResponse.json({ mode, threshold });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}

// POST /api/profile/apply-mode — saves apply mode and optional threshold
// Body: { mode: 'smart' | 'all', threshold?: number }
export async function POST(request: Request) {
  try {
    const body = await request.json() as { mode?: string; threshold?: number };
    const mode = body.mode === 'all' ? 'all' : 'smart';
    const threshold = typeof body.threshold === 'number' ? Math.max(0, Math.min(100, body.threshold)) : 60;

    db.prepare("INSERT OR REPLACE INTO user_settings (key, value) VALUES ('apply_mode', ?)").run(mode);
    db.prepare("INSERT OR REPLACE INTO user_settings (key, value) VALUES ('score_threshold', ?)").run(String(threshold));

    return NextResponse.json({ ok: true, mode, threshold });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
