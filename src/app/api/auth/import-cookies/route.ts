import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const LOCALAPPDATA = process.env.LOCALAPPDATA || '';
const SYS_USER_DATA = path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const SYS_COOKIES = path.join(SYS_USER_DATA, 'Default', 'Network', 'Cookies');
const SYS_LOCAL_STATE = path.join(SYS_USER_DATA, 'Local State');
const SYS_PREFERENCES = path.join(SYS_USER_DATA, 'Default', 'Preferences');

const DST_PROFILE = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
const DST_DEFAULT = path.join(DST_PROFILE, 'Default');
const DST_NETWORK = path.join(DST_DEFAULT, 'Network');
const DST_COOKIES = path.join(DST_NETWORK, 'Cookies');

function isChromeRunning(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-Process chrome -ErrorAction SilentlyContinue).Count"', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    return parseInt(out || '0', 10) > 0;
  } catch {
    return false;
  }
}

function closeChrome(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execSync('powershell -NoProfile -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue"', {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  let force = false;
  try {
    const body = await req.json();
    if (body?.force) force = true;
  } catch {}

  if (!fs.existsSync(SYS_COOKIES)) {
    return NextResponse.json(
      { ok: false, error: 'Could not find your Google Chrome User Data directory.' },
      { status: 404 }
    );
  }

  // If Chrome is running and force is requested, close it
  if (isChromeRunning()) {
    if (force) {
      closeChrome();
      // wait 1 second for file handles to release
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      return NextResponse.json({
        ok: false,
        chromeRunning: true,
        error: 'Google Chrome is currently open. Please close your Chrome browser (or click "Close Chrome & Import") so HireMe can copy your session cookies.',
      });
    }
  }

  // Ensure destination folders exist
  if (!fs.existsSync(DST_NETWORK)) {
    fs.mkdirSync(DST_NETWORK, { recursive: true });
  }

  try {
    // 1. Copy Local State (encryption keys)
    if (fs.existsSync(SYS_LOCAL_STATE)) {
      fs.copyFileSync(SYS_LOCAL_STATE, path.join(DST_PROFILE, 'Local State'));
    }

    // 2. Copy Preferences (account list)
    if (fs.existsSync(SYS_PREFERENCES)) {
      fs.copyFileSync(SYS_PREFERENCES, path.join(DST_DEFAULT, 'Preferences'));
    }

    // 3. Copy Cookies database & Network Persistent State
    fs.copyFileSync(SYS_COOKIES, DST_COOKIES);
    const sysNps = path.join(SYS_USER_DATA, 'Default', 'Network', 'Network Persistent State');
    if (fs.existsSync(sysNps)) {
      try { fs.copyFileSync(sysNps, path.join(DST_NETWORK, 'Network Persistent State')); } catch {}
    }

    // 4. Copy Local Storage (where SPAs like Naukri store auth state)
    const sysLs = path.join(SYS_USER_DATA, 'Default', 'Local Storage');
    const dstLs = path.join(DST_DEFAULT, 'Local Storage');
    if (fs.existsSync(sysLs)) {
      try { fs.cpSync(sysLs, dstLs, { recursive: true, force: true }); } catch {}
    }

    // 5. Copy Session Storage & IndexedDB if present
    const sysSs = path.join(SYS_USER_DATA, 'Default', 'Session Storage');
    const dstSs = path.join(DST_DEFAULT, 'Session Storage');
    if (fs.existsSync(sysSs)) {
      try { fs.cpSync(sysSs, dstSs, { recursive: true, force: true }); } catch {}
    }

    return NextResponse.json({
      ok: true,
      message: 'Successfully imported your signed-in Google accounts, platform cookies, and local session storage into HireMe!',
    });
  } catch (err) {
    console.error('[api/auth/import-cookies] Error copying cookies:', err);
    return NextResponse.json(
      {
        ok: false,
        error: `Could not copy cookies: ${err instanceof Error ? err.message : String(err)}. Make sure Chrome is closed.`,
      },
      { status: 500 }
    );
  }
}
