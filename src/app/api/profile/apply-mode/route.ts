import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { getApplyConfig, saveApplyConfig } from '@/lib/apply/questions';

// GET /api/profile/apply-mode — returns the current apply mode, score threshold, and resume source
export async function GET() {
  try {
    const mode = (db.prepare("SELECT value FROM user_settings WHERE key = 'apply_mode'").get() as { value: string } | undefined)?.value ?? 'smart';
    const threshold = parseInt((db.prepare("SELECT value FROM user_settings WHERE key = 'score_threshold'").get() as { value: string } | undefined)?.value ?? '60', 10);
    const cfg = getApplyConfig();
    const resumeSource = cfg.resumeSource ?? (mode === 'smart' ? 'original' : 'tailored');
    return NextResponse.json({ mode, threshold, resumeSource });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}

// POST /api/profile/apply-mode — saves apply mode, optional threshold, and optional resumeSource
// Body: { mode: 'smart' | 'all', threshold?: number, resumeSource?: 'original' | 'tailored' }
export async function POST(request: Request) {
  try {
    const body = await request.json() as { mode?: string; threshold?: number; resumeSource?: 'original' | 'tailored' };
    const mode = body.mode === 'all' ? 'all' : 'smart';
    const threshold = typeof body.threshold === 'number' ? Math.max(0, Math.min(100, body.threshold)) : 60;

    db.prepare("INSERT OR REPLACE INTO user_settings (key, value) VALUES ('apply_mode', ?)").run(mode);
    db.prepare("INSERT OR REPLACE INTO user_settings (key, value) VALUES ('score_threshold', ?)").run(String(threshold));

    // Align apply_settings config_json resumeSource
    const cfg = getApplyConfig();
    if (body.resumeSource === 'original' || body.resumeSource === 'tailored') {
      cfg.resumeSource = body.resumeSource;
    } else {
      cfg.resumeSource = mode === 'smart' ? 'original' : 'tailored';
    }
    saveApplyConfig(cfg);

    return NextResponse.json({ ok: true, mode, threshold, resumeSource: cfg.resumeSource });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
