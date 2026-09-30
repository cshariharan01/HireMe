import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { launchApplyBrowser, bringWindowToFront, cleanupStaleProfileLock } from '@/lib/apply/launcher';
import { clearPlatformSession } from '@/lib/apply/auth-session';

// Use the persistent profile where auto-apply and ingest scripts look for cookies
const PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

/**
 * Copies Google account preferences and configuration from the user's real Chrome
 * profile into the HireMe browser profile so 'Continue with Google' recognizes
 * already-signed-in accounts on the system.
 * NOTE: Cookies are NOT copied because Windows DPAPI and App-Bound Encryption
 * require cookies to be created within the profile that decrypts them.
 */
function seedFromSystemChrome(targetDir: string) {
  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return;
    const sysUserData = path.join(localAppData, 'Google', 'Chrome', 'User Data');
    if (!fs.existsSync(sysUserData)) return;

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // 1. Copy Local State (contains account identities)
    const sysLocalState = path.join(sysUserData, 'Local State');
    const targetLocalState = path.join(targetDir, 'Local State');
    if (fs.existsSync(sysLocalState) && !fs.existsSync(targetLocalState)) {
      try { fs.copyFileSync(sysLocalState, targetLocalState); } catch {}
    }

    // 2. Copy Default/Preferences (contains logged-in Google email addresses)
    const sysDefaultDir = path.join(sysUserData, 'Default');
    const targetDefaultDir = path.join(targetDir, 'Default');
    if (fs.existsSync(sysDefaultDir)) {
      if (!fs.existsSync(targetDefaultDir)) fs.mkdirSync(targetDefaultDir, { recursive: true });
      const sysPref = path.join(sysDefaultDir, 'Preferences');
      const targetPref = path.join(targetDefaultDir, 'Preferences');
      if (fs.existsSync(sysPref) && !fs.existsSync(targetPref)) {
        try { fs.copyFileSync(sysPref, targetPref); } catch {}
      }
    }
  } catch {}
}

export async function POST(req: NextRequest) {
  let platform: 'naukri' | 'linkedin' = 'naukri';
  let clearSession = false;

  try {
    const body = await req.json();
    if (body?.platform && ['naukri', 'linkedin'].includes(body.platform)) {
      platform = body.platform;
    }
    if (body?.clearSession === true || body?.relogin === true) {
      clearSession = true;
    }
  } catch {
    /* default naukri */
  }

  // If user requested switching/re-logging into account, wipe the existing platform session first
  if (clearSession) {
    await clearPlatformSession(platform, PROFILE_DIR).catch(() => {});
  }

  const targetUrl =
    platform === 'naukri'
      ? 'https://www.naukri.com/nlogin/login'
      : 'https://www.linkedin.com/login';

  // Seed profile from system Chrome so signed in Google accounts are known
  seedFromSystemChrome(PROFILE_DIR);

  // 1. Terminate any hidden/stale background Chrome processes running on browser-profile
  cleanupStaleProfileLock(PROFILE_DIR);

  // 2. Remove stale lockfiles if left behind
  try {
    const lockPath = path.join(PROFILE_DIR, 'lockfile');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    const singletonLockPath = path.join(PROFILE_DIR, 'SingletonLock');
    if (fs.existsSync(singletonLockPath)) fs.unlinkSync(singletonLockPath);
  } catch {
    /* ignore */
  }

  // 3. Launch fresh visible Chrome browser context with anti-detection flags
  try {
    const browser = await launchApplyBrowser(PROFILE_DIR, {
      locale: 'en-IN',
      focus: true,
    });

    const pages = browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    bringWindowToFront('Chrome', true);

    return NextResponse.json({
      ok: true,
      platform,
      message: `Chrome opened at ${platform === 'naukri' ? 'Naukri' : 'LinkedIn'} login page. Please sign in in Chrome.`,
    });
  } catch (err) {
    console.error('[api/auth/login] Error launching login browser:', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Could not launch login browser' },
      { status: 500 }
    );
  }
}
