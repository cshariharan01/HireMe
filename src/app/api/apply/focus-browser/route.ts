import { NextResponse } from 'next/server';
import { bringWindowToFront, cancelApplySession, closeActiveApplyBrowser, resetWindowFocusTracking } from '@/lib/apply/launcher';

// POST /api/apply/focus-browser
// Brings the active Playwright Chrome window running the application to the front of Windows.
// When explicitly invoked by the user, force=true to ensure the window comes to front.
export async function POST() {
  bringWindowToFront('Chrome', true);
  return NextResponse.json({ ok: true });
}

// PUT /api/apply/focus-browser
// Resets window focus tracking so the first job of a new auto-apply queue or session brings the window to front.
export async function PUT() {
  resetWindowFocusTracking();
  return NextResponse.json({ ok: true });
}

// DELETE /api/apply/focus-browser
// Cancels any running auto-apply session and closes the Chrome window immediately.
export async function DELETE() {
  cancelApplySession();
  await closeActiveApplyBrowser();
  return NextResponse.json({ ok: true });
}
