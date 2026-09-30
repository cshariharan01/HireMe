import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { closeActiveApplyBrowser, cleanupStaleProfileLock, getActiveApplyBrowser } from './launcher';

export const BROWSER_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

/**
 * Checks whether valid, authenticated session cookies exist for LinkedIn and Naukri.
 * Uses a robust 3-tier inspection strategy:
 * 1. Queries live Playwright context via CDP if Chrome is currently open.
 * 2. Reads Local Storage LevelDB files (which Windows leaves accessible even when Chrome locks Cookies).
 * 3. Reads SQLite Cookies database when Chrome is closed.
 */
export async function checkPlatformAuthStatus(profileDir = BROWSER_PROFILE_DIR): Promise<{ linkedin: boolean; naukri: boolean }> {
  let linkedin = false;
  let naukri = false;

  // ── Tier 1: Query live Playwright browser context if Chrome is running ──
  try {
    const ctx = await getActiveApplyBrowser(profileDir);
    if (ctx && ctx.browser()?.isConnected()) {
      const cookies = await ctx.cookies().catch(() => []);
      for (const c of cookies) {
        const dom = (c.domain || '').toLowerCase();
        if (dom.includes('linkedin') && (c.name === 'li_at' || c.name === 'liap')) {
          linkedin = true;
        }
        if (
          dom.includes('naukri') &&
          ['nauk_at', 'nauk_sid', 'nauk_rt', 'is_login', 'NKWAP', 'nkauth', 'USER', 'npsso'].includes(c.name)
        ) {
          naukri = true;
        }
      }
      // Also check URLs of currently open tabs
      for (const p of ctx.pages()) {
        try {
          const url = p.url();
          if (url.includes('linkedin.com') && !url.includes('/login') && !url.includes('/uas/login')) {
            linkedin = true;
          }
          if (
            url.includes('naukri.com') &&
            (url.includes('/mnjuser') || url.includes('/homepage') || (!url.includes('/login') && !url.includes('/nlogin')))
          ) {
            naukri = true;
          }
        } catch {}
      }
      if (linkedin && naukri) return { linkedin, naukri };
    }
  } catch {}

  // ── Tier 2: Check Local Storage leveldb (readable even when Chrome locks Cookies) ──
  try {
    const lsDir = path.join(profileDir, 'Default', 'Local Storage', 'leveldb');
    if (fs.existsSync(lsDir)) {
      const files = fs.readdirSync(lsDir).filter((f) => f.endsWith('.log') || f.endsWith('.ldb'));
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(lsDir, f), 'latin1');
          if (
            !naukri &&
            content.includes('_https://www.naukri.com') &&
            (content.includes('globalWidgetState-') ||
              content.includes('userData') ||
              content.includes('subUserType') ||
              content.includes('resId') ||
              content.includes('isEmail'))
          ) {
            naukri = true;
          }
          if (
            !linkedin &&
            content.includes('_https://www.linkedin.com') &&
            (content.includes('voyager-web') || content.includes('li_at') || content.includes('member') || content.includes('miniProfile'))
          ) {
            linkedin = true;
          }
        } catch {}
      }
      if (linkedin && naukri) return { linkedin, naukri };
    }
  } catch {}

  // ── Tier 3: Check SQLite Cookies on disk (when Chrome is closed and lock is released) ──
  const cookiePath = path.join(profileDir, 'Default', 'Network', 'Cookies');
  if (fs.existsSync(cookiePath)) {
    const tempCopy = path.join(
      process.cwd(),
      'data',
      'playwright',
      `status-check-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`
    );

    try {
      try {
        fs.copyFileSync(cookiePath, tempCopy);
      } catch {
        const { execSync } = require('child_process');
        execSync(`cmd /c copy /y "${cookiePath}" "${tempCopy}"`, { stdio: 'ignore' });
      }

      if (fs.existsSync(tempCopy)) {
        const db = new Database(tempCopy, { readonly: true, fileMustExist: true });
        if (!linkedin) {
          const liRow = db
            .prepare("SELECT name FROM cookies WHERE host_key LIKE '%linkedin%' AND name IN ('li_at', 'liap') LIMIT 1")
            .get();
          if (liRow) linkedin = true;
        }
        if (!naukri) {
          const nkAuth = db
            .prepare(
              "SELECT name FROM cookies WHERE host_key LIKE '%naukri%' AND name IN ('nauk_at', 'nauk_sid', 'nauk_rt', 'is_login', 'NKWAP', 'nkauth', 'USER', 'npsso') LIMIT 1"
            )
            .get();
          if (nkAuth) {
            naukri = true;
          }
        }
        db.close();
      }
    } catch (err) {
      // Ignored: expected if Chrome holds exclusive lock
    } finally {
      try {
        if (fs.existsSync(tempCopy)) fs.unlinkSync(tempCopy);
      } catch {}
    }
  }

  return { linkedin, naukri };
}

/**
 * Completely clears platform cookies, session storage, and IndexedDB for Naukri, LinkedIn,
 * or all platforms from the dedicated HireMe browser profile.
 */
export async function clearPlatformSession(
  platform: 'naukri' | 'linkedin' | 'all',
  profileDir = BROWSER_PROFILE_DIR
): Promise<{ ok: boolean; removedCookies: number; message: string }> {
  let removedCookies = 0;

  try {
    // 1. Close any active Playwright browser contexts
    await closeActiveApplyBrowser().catch(() => {});

    // 2. Terminate background Chrome processes holding locks on this profile
    cleanupStaleProfileLock(profileDir);
    await new Promise((r) => setTimeout(r, 600));

    // 3. Clear SQLite cookies
    const cookiePath = path.join(profileDir, 'Default', 'Network', 'Cookies');
    if (fs.existsSync(cookiePath)) {
      try {
        const db = new Database(cookiePath);
        if (platform === 'naukri') {
          const res = db.prepare("DELETE FROM cookies WHERE host_key LIKE '%naukri%'").run();
          removedCookies = res.changes;
        } else if (platform === 'linkedin') {
          const res = db.prepare("DELETE FROM cookies WHERE host_key LIKE '%linkedin%'").run();
          removedCookies = res.changes;
        } else {
          const res = db
            .prepare("DELETE FROM cookies WHERE host_key LIKE '%naukri%' OR host_key LIKE '%linkedin%'")
            .run();
          removedCookies = res.changes;
        }
        db.close();
      } catch (err) {
        console.warn('[auth-session] Error clearing cookies SQLite:', err);
      }
    }

    // 4. Remove matching IndexedDB origins
    const idbDir = path.join(profileDir, 'Default', 'IndexedDB');
    if (fs.existsSync(idbDir)) {
      try {
        const entries = fs.readdirSync(idbDir);
        for (const entry of entries) {
          const lower = entry.toLowerCase();
          const shouldDelete =
            (platform === 'naukri' && lower.includes('naukri')) ||
            (platform === 'linkedin' && lower.includes('linkedin')) ||
            (platform === 'all' && (lower.includes('naukri') || lower.includes('linkedin')));

          if (shouldDelete) {
            fs.rmSync(path.join(idbDir, entry), { recursive: true, force: true });
          }
        }
      } catch (err) {
        console.warn('[auth-session] Error clearing IndexedDB:', err);
      }
    }

    // 5. Clean up Local Storage when disconnecting all or platform
    const lsDir = path.join(profileDir, 'Default', 'Local Storage');
    if (fs.existsSync(lsDir)) {
      try {
        fs.rmSync(lsDir, { recursive: true, force: true });
      } catch {}
    }

    const ssDir = path.join(profileDir, 'Default', 'Session Storage');
    if (fs.existsSync(ssDir)) {
      try {
        fs.rmSync(ssDir, { recursive: true, force: true });
      } catch {}
    }

    return {
      ok: true,
      removedCookies,
      message: `Cleared ${removedCookies} cookies and sessions for ${platform}.`,
    };
  } catch (err) {
    console.error('[auth-session] Failed to clear platform session:', err);
    return {
      ok: false,
      removedCookies,
      message: err instanceof Error ? err.message : 'Failed to clear platform session',
    };
  }
}
