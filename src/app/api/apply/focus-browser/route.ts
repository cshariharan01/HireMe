import { NextResponse } from 'next/server';
import { bringWindowToFront, cancelApplySession, closeActiveApplyBrowser } from '@/lib/apply/launcher';

// POST /api/apply/focus-browser
// Brings the active Playwright Chrome window running the application to the front of Windows.
export async function POST() {
  bringWindowToFront('Chrome');
  return NextResponse.json({ ok: true });
}

// DELETE /api/apply/focus-browser
// Cancels any running auto-apply session and closes the Chrome window immediately.
export async function DELETE() {
  cancelApplySession();
  await closeActiveApplyBrowser();
  return NextResponse.json({ ok: true });
}
