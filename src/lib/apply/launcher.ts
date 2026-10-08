// Shared browser launcher for the auto-apply adapters.
//
// Prefers the REAL installed Chrome (`channel: 'chrome'`) instead of Playwright's bundled
// Chromium. Launching via `launchPersistentContext` always spawns a SEPARATE Chrome process
// with its OWN window and profile directory (`data/playwright/browser-profile`) — it never
// attaches to the user's everyday browsing windows/tabs and cannot disturb other work. The real
// binary is used so the user recognises the browser, the rendered pages match how their own
// Chrome renders them, and any OS-level session bits Chrome carries (e.g. the language fallback)
// behave like normal browsing.
//
// Falls back to the bundled Chromium binary when the `chrome` channel is unavailable.
//
// IMPORTANT: On Windows, Chrome stores cookies encrypted with DPAPI. A separate Chrome process
// can ONLY decrypt cookies that were encrypted by the same profile it's opening. This means the
// isolated `browser-profile` cannot use cookies copied from the user's real Chrome — they remain
// encrypted and LinkedIn shows "not signed in". The fix: for platforms where login is required
// (LinkedIn), launch using the user's REAL Chrome profile so Chrome decrypts its own cookies.
// Use `getSystemChromeProfileDir()` to get that path.

import { chromium, type BrowserContext, type Page } from 'playwright';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export const FALLBACK_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

const BASE_ARGS = [
  '--start-maximized',
  '--lang=en-US',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--test-type',
];

export const AUTO_APPLY_SUCCESS_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>HireMe Auto-Apply</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      background: #090d16;
      color: #f1f5f9;
      user-select: none;
    }
    .card {
      text-align: center;
      padding: 2.5rem;
      background: #131b2e;
      border-radius: 1rem;
      border: 1px solid #1e293b;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      max-width: 440px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(16,185,129,0.15);
      color: #34d399;
      border: 1px solid rgba(16,185,129,0.3);
      padding: 0.4rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.875rem;
      font-weight: 600;
      margin-bottom: 1.25rem;
    }
    h2 { margin: 0 0 0.5rem 0; font-size: 1.25rem; font-weight: 600; color: #f1f5f9; }
    p { margin: 0; color: #94a3b8; font-size: 0.875rem; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">✓ Application Submitted</div>
    <h2>HireMe Auto-Apply Active</h2>
    <p>Application completed successfully.<br>Holding browser window ready for the next job in queue.</p>
  </div>
</body>
</html>
`)}`;

export interface ApplyLaunchOptions {
  /** Override the default English locale. Defaults to en-US. */
  locale?: string;
  /** Extra HTTP headers applied to every request from the context. */
  extraHTTPHeaders?: Record<string, string>;
  /** Additional Chromium/Chrome command-line arguments. */
  args?: string[];
  /** Whether to steal OS focus and bring window to front. Defaults to false so automated applies don't disrupt user work. */
  focus?: boolean;
}

export const PROFILE_IN_USE_ERROR =
  'Another auto-apply window is still open on the same browser profile, so a new one could not start. Close the open auto-apply window (or finish that application) and try again.';

const DEFAULT_HEADERS: Record<string, string> = { 'Accept-Language': 'en-US,en;q=0.9' };

interface GlobalBrowserHolder {
  __hiresignal_activeContext?: BrowserContext | null;
  __hiresignal_activeUserDataDir?: string | null;
  __hiresignal_applyCancelled?: boolean;
  __hiresignal_cancelledAt?: number;
  __hiresignal_windowBroughtToFront?: boolean;
  __hiresignal_lastApplyAt?: number;
}

const g = globalThis as unknown as GlobalBrowserHolder;

export function resetWindowFocusTracking(): void {
  g.__hiresignal_windowBroughtToFront = false;
  g.__hiresignal_lastApplyAt = 0;
}

export function shouldBringWindowToFront(force = false): boolean {
  if (force) return true;
  if (!g.__hiresignal_windowBroughtToFront) {
    return true;
  }
  const now = Date.now();
  if (g.__hiresignal_lastApplyAt && now - g.__hiresignal_lastApplyAt > 15 * 60 * 1000) {
    return true;
  }
  return false;
}

export async function focusApplyPage(page?: Page | null, force = false): Promise<boolean> {
  if (!shouldBringWindowToFront(force)) {
    return false;
  }
  g.__hiresignal_windowBroughtToFront = true;
  g.__hiresignal_lastApplyAt = Date.now();

  if (page && !page.isClosed()) {
    try {
      await page.bringToFront().catch(() => {});
      await page.evaluate(() => { try { window.focus(); } catch {} }).catch(() => {});
    } catch {}
  }
  return bringWindowToFront('Chrome', true);
}

export function cancelApplySession(): void {
  g.__hiresignal_applyCancelled = true;
  g.__hiresignal_cancelledAt = Date.now();
  resetWindowFocusTracking();
  void closeActiveApplyBrowser();
}

export function resetApplyCancellation(): void {
  g.__hiresignal_applyCancelled = false;
  g.__hiresignal_cancelledAt = 0;
}

export function isApplyCancelled(startedAt?: number): boolean {
  if (!g.__hiresignal_applyCancelled) return false;
  if (!startedAt) return true;
  return (g.__hiresignal_cancelledAt || 0) >= startedAt;
}

export async function getActiveApplyBrowser(userDataDir?: string): Promise<BrowserContext | null> {
  const ctx = g.__hiresignal_activeContext;
  if (ctx && (!userDataDir || g.__hiresignal_activeUserDataDir === userDataDir)) {
    try {
      if (ctx.browser()?.isConnected() && ctx.pages().length > 0) {
        return ctx;
      }
    } catch {
      g.__hiresignal_activeContext = null;
      g.__hiresignal_activeUserDataDir = null;
    }
  }
  return null;
}

export async function closeActiveApplyBrowser(): Promise<void> {
  const ctx = g.__hiresignal_activeContext;
  if (ctx) {
    try {
      await ctx.close();
    } catch {
      /* ignore */
    } finally {
      g.__hiresignal_activeContext = null;
      g.__hiresignal_activeUserDataDir = null;
      resetWindowFocusTracking();
    }
  }
  // Terminate any helper processes on our profile directories so Chrome cannot linger
  try {
    cleanupStaleProfileLock(path.join(process.cwd(), 'data', 'playwright', 'browser-profile'));
    cleanupStaleProfileLock(path.join(process.cwd(), 'data', 'playwright', 'naukri-profile'));
  } catch {}
}

/**
 * Launch a persistent browser context (real Chrome when available). Always a new, separate
 * browser process/window — never the user's running windows.
 *
 * Real Chrome refuses to start a second instance on a profile directory another Chrome still
 * holds (`RESULT_CODE_PROFILE_IN_USE`, exit 21). The apply flow deliberately leaves the window
 * open for manual review, so a second apply can collide with a live one. Wait briefly for the
 * lock to clear, then fail with an actionable message instead of a cryptic launch crash.
 */

export function bringWindowToFront(titleKeyword = 'Chrome', force = false): boolean {
  if (process.platform !== 'win32') return false;
  if (!shouldBringWindowToFront(force)) {
    return false;
  }
  g.__hiresignal_windowBroughtToFront = true;
  g.__hiresignal_lastApplyAt = Date.now();
  try {
    // Fast synchronous foreground switch (< 100ms) so Chrome is on top before any page clicks
    execSync(
      `powershell -NoProfile -NonInteractive -Command "$wshell = New-Object -ComObject WScript.Shell; $wshell.AppActivate('${titleKeyword}'); $wshell.AppActivate('Chrome')"`,
      { stdio: 'ignore', timeout: 1000 }
    );
  } catch {}


  try {
    const psScript = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinWindowFocus {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;

    public static bool ForceForeground(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return false;
        try {
            SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, 0x0002);
            uint fgProcId;
            uint fgThreadId = GetWindowThreadProcessId(GetForegroundWindow(), out fgProcId);
            uint curThreadId = GetCurrentThreadId();
            if (fgThreadId != 0 && fgThreadId != curThreadId) {
                AttachThreadInput(curThreadId, fgThreadId, true);
            }
            if (IsIconic(hwnd)) {
                ShowWindow(hwnd, 9); // SW_RESTORE
            }
            ShowWindow(hwnd, 5); // SW_SHOW
            ShowWindow(hwnd, 3); // SW_SHOWMAXIMIZED
            keybd_event(0x12, 0, 0, 0); // Alt press
            keybd_event(0x12, 0, 2, 0); // Alt release
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
            SwitchToThisWindow(hwnd, true);
            if (fgThreadId != 0 && fgThreadId != curThreadId) {
                AttachThreadInput(curThreadId, fgThreadId, false);
            }
            return true;
        } catch { return false; }
    }

    public static bool FocusChromeWindows() {
        bool focused = false;
        EnumWindows((hwnd, lParam) => {
            StringBuilder sbClass = new StringBuilder(256);
            GetClassName(hwnd, sbClass, 256);
            StringBuilder sbTitle = new StringBuilder(256);
            GetWindowText(hwnd, sbTitle, 256);
            string cls = sbClass.ToString();
            string title = sbTitle.ToString();
            if (cls == "Chrome_WidgetWin_1" && !string.IsNullOrEmpty(title)) {
                ForceForeground(hwnd);
                focused = true;
            }
            return true;
        }, IntPtr.Zero);
        return focused;
    }
}
"@

$focused = $false
for ($i = 0; $i -lt 10; $i++) {
    $focused = [WinWindowFocus]::FocusChromeWindows()
    if ($focused) { break }
    Start-Sleep -Milliseconds 300
}
if (-not $focused) {
  $wshell = New-Object -ComObject WScript.Shell
  $wshell.AppActivate('${titleKeyword}')
  $wshell.AppActivate('Chrome')
}
`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
  } catch {
    // ignore
  }
  return true;
}

export function cleanupStaleProfileLock(userDataDir?: string) {
  try {
    if (process.platform === 'win32') {
      const dirBase = userDataDir ? path.basename(userDataDir) : '';
      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*browser-profile*' -or $_.CommandLine -like '*naukri-profile*' ${dirBase ? `-or $_.CommandLine -like '*${dirBase}*'` : ''} } | Stop-Process -Force -ErrorAction SilentlyContinue"`;
      execSync(cmd, { stdio: 'ignore', timeout: 2500 });
    } else {
      execSync(`pkill -f "browser-profile|naukri-profile"`, { stdio: 'ignore', timeout: 2000 });
    }
  } catch {
    // ignore
  }

  // Also remove stale lockfiles if left behind
  if (userDataDir) {
    try {
      const lockPath = path.join(userDataDir, 'lockfile');
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
    try {
      const singletonLockPath = path.join(userDataDir, 'SingletonLock');
      if (fs.existsSync(singletonLockPath)) fs.unlinkSync(singletonLockPath);
    } catch {
      // ignore
    }
  }
}

async function tryLaunchPersistent(userDataDir: string, opts: Parameters<typeof chromium.launchPersistentContext>[1]): Promise<BrowserContext> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await chromium.launchPersistentContext(userDataDir, opts);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message || '';
      const profileLocked = /ProcessSingleton|RESULT_CODE_PROFILE_IN_USE|process did exit|browser has been closed|Target page, context or browser has been closed|lock/i.test(msg);
      if (!profileLocked || attempt === 2) throw err;
      console.warn('[apply] profile dir locked by another Chrome instance — cleaning up stale helpers and retrying...');
      cleanupStaleProfileLock(userDataDir);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

/**
 * Returns the user's real Chrome Default profile directory (Windows/macOS/Linux).
 * When it exists, launching with this directory means Chrome decrypts its own DPAPI cookies,
 * so LinkedIn/Naukri sessions are automatically active. Returns null if Chrome is not installed
 * or the profile can't be found.
 */
export function getSystemChromeProfileDir(): string | null {
  try {
    let candidateDirs: string[] = [];
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || '';
      if (localAppData) candidateDirs.push(path.join(localAppData, 'Google', 'Chrome', 'User Data'));
    } else if (process.platform === 'darwin') {
      const home = process.env.HOME || '';
      if (home) candidateDirs.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'));
    } else {
      const home = process.env.HOME || '';
      if (home) candidateDirs.push(path.join(home, '.config', 'google-chrome'));
    }
    for (const dir of candidateDirs) {
      const cookiesPath = path.join(dir, 'Default', 'Network', 'Cookies');
      if (fs.existsSync(cookiesPath)) {
        console.log('[apply] using real Chrome profile for login session:', dir);
        return dir;
      }
    }
  } catch {
    // ignore — fallback to isolated profile
  }
  return null;
}

/**
 * Seed non-cookie state from system Chrome into targetDir if targetDir is new.
 * Note: Cookies are NOT copied because Windows ABE/DPAPI causes browser cookie purges.
 */
export function seedFromSystemChrome(targetDir: string) {
  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return;
    const sysUserData = path.join(localAppData, 'Google', 'Chrome', 'User Data');
    if (!fs.existsSync(sysUserData) || sysUserData === targetDir) return;

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // Copy Default directory non-cookie assets: Preferences, Local Storage, Session Storage
    const sysDefaultDir = path.join(sysUserData, 'Default');
    const targetDefaultDir = path.join(targetDir, 'Default');
    if (fs.existsSync(sysDefaultDir)) {
      if (!fs.existsSync(targetDefaultDir)) fs.mkdirSync(targetDefaultDir, { recursive: true });

      const sysPref = path.join(sysDefaultDir, 'Preferences');
      const targetPref = path.join(targetDefaultDir, 'Preferences');
      if (fs.existsSync(sysPref) && !fs.existsSync(targetPref)) {
        try { fs.copyFileSync(sysPref, targetPref); } catch {}
      }

      const sysLs = path.join(sysDefaultDir, 'Local Storage');
      const targetLs = path.join(targetDefaultDir, 'Local Storage');
      if (fs.existsSync(sysLs) && !fs.existsSync(targetLs)) {
        try { fs.cpSync(sysLs, targetLs, { recursive: true, force: true }); } catch {}
      }
    }
  } catch (err) {
    console.warn('[apply] Error seeding from system Chrome:', err);
  }
}

export async function launchApplyBrowser(
  userDataDir: string,
  opts: ApplyLaunchOptions = {},
): Promise<BrowserContext> {
  const shouldFocus = opts.focus ?? true;

  // Reuse active connected browser session if one already exists for this profile
  const existing = await getActiveApplyBrowser(userDataDir);
  if (existing) {
    console.log('[apply] reusing existing active browser session (already open) — keeping in background');
    return existing;
  }

  const launchOpts = {
    headless: false,
    viewport: null,
    locale: opts.locale ?? 'en-US',
    extraHTTPHeaders: opts.extraHTTPHeaders ?? DEFAULT_HEADERS,
    args: Array.from(new Set([...BASE_ARGS, ...(opts.args || [])])),
    ignoreDefaultArgs: ['--enable-automation'],
  };

  try {
    const ctx = await tryLaunchPersistent(userDataDir, {
      ...launchOpts,
      channel: 'chrome',
      ignoreDefaultArgs: ['--enable-automation'],
    });
    console.log('[apply] launched real Chrome (channel=chrome)');
    try {
      await ctx.addInitScript(() => {
        try {
          delete (Object.getPrototypeOf(navigator) as any).webdriver;
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch {}
      });
    } catch {}
    g.__hiresignal_activeContext = ctx;
    g.__hiresignal_activeUserDataDir = userDataDir;
    ctx.on('close', () => {
      if (g.__hiresignal_activeContext === ctx) {
        g.__hiresignal_activeContext = null;
        g.__hiresignal_activeUserDataDir = null;
        resetWindowFocusTracking();
      }
    });

    if (shouldFocus && shouldBringWindowToFront(false)) {
      try {
        const page = ctx.pages()[0];
        if (page && !page.isClosed()) {
          await page.bringToFront().catch(() => {});
          await page.evaluate(() => { try { window.focus(); } catch {} }).catch(() => {});
        }
      } catch {}
      bringWindowToFront('Chrome', true);
      setTimeout(() => bringWindowToFront('Chrome', true), 200);
      setTimeout(() => bringWindowToFront('Chrome', true), 600);
      setTimeout(() => bringWindowToFront('Chrome', true), 1200);
      setTimeout(() => bringWindowToFront('Chrome', true), 2500);
    }
    return ctx;
  } catch (err) {
    const msg = (err as Error).message || '';
    console.warn(`[apply] Primary Chrome profile unavailable (${msg.slice(0, 100)}) — launching isolated profile fallback`);
    const fallbackDir = userDataDir !== FALLBACK_PROFILE_DIR ? FALLBACK_PROFILE_DIR : userDataDir;
    if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
    seedFromSystemChrome(fallbackDir);

    const fallbackCtx = await tryLaunchPersistent(fallbackDir, {
      ...launchOpts,
      channel: 'chrome',
      ignoreDefaultArgs: ['--enable-automation'],
    }).catch(async () => {
      return await tryLaunchPersistent(fallbackDir, launchOpts);
    });

    try {
      await fallbackCtx.addInitScript(() => {
        try {
          delete (Object.getPrototypeOf(navigator) as any).webdriver;
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch {}
      });
    } catch {}
    g.__hiresignal_activeContext = fallbackCtx;
    g.__hiresignal_activeUserDataDir = fallbackDir;
    fallbackCtx.on('close', () => {
      if (g.__hiresignal_activeContext === fallbackCtx) {
        g.__hiresignal_activeContext = null;
        g.__hiresignal_activeUserDataDir = null;
        resetWindowFocusTracking();
      }
    });

    if (shouldFocus && shouldBringWindowToFront(false)) {
      try {
        const page = fallbackCtx.pages()[0];
        if (page && !page.isClosed()) {
          await page.bringToFront().catch(() => {});
          await page.evaluate(() => { try { window.focus(); } catch {} }).catch(() => {});
        }
      } catch {}
      bringWindowToFront('Chrome', true);
      setTimeout(() => bringWindowToFront('Chrome', true), 200);
      setTimeout(() => bringWindowToFront('Chrome', true), 600);
      setTimeout(() => bringWindowToFront('Chrome', true), 1200);
      setTimeout(() => bringWindowToFront('Chrome', true), 2500);
    }
    return fallbackCtx;
  }
}