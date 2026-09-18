import { NextRequest, NextResponse } from 'next/server';
import { startSync, cancelSync, getSyncStatus, type SyncMode } from '@/lib/sync';

// GET /api/sync — current status (UI polls this while running).
export async function GET() {
  return NextResponse.json(getSyncStatus());
}

// POST /api/sync { mode: 'linkedin' | 'naukri' | 'full' | 'quick' | 'rate' } — start a sync run.
export async function POST(req: NextRequest) {
  let mode: SyncMode = 'linkedin';
  try {
    const body = await req.json();
    if (body?.mode && ['linkedin', 'naukri', 'full', 'quick', 'rate'].includes(body.mode)) {
      mode = body.mode;
    }
  } catch { /* default linkedin */ }

  const result = startSync(mode);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }
  return NextResponse.json({ ok: true, ...getSyncStatus() });
}

// DELETE /api/sync — cancel the running sync.
export async function DELETE() {
  const cancelled = cancelSync();
  if (!cancelled) return NextResponse.json({ error: 'No sync is running.' }, { status: 409 });
  return NextResponse.json({ ok: true });
}
