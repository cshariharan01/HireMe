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

import { chromium, type BrowserContext } from 'playwright';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const BASE_ARGS = [
  '--new-window',
  '--start-maximized',
  '--lang=en-US',
  '--no-first-run',
  '--no-default-browser-check',
];

export const AUTO_APPLY_SUCCESS_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>HireSignal Auto-Apply</title>
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
    <h2>HireSignal Auto-Apply Active</h2>
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
}

const g = globalThis as unknown as GlobalBrowserHolder;

export function cancelApplySession(): void {
  g.__hiresignal_applyCancelled = true;
  g.__hiresignal_cancelledAt = Date.now();
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

export function bringWindowToFront(titleKeyword = 'Chrome') {
  if (process.platform !== 'win32') return;
  try {
    const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinWindow {
    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
"@
$activated = $false
for ($attempt = 0; $attempt -lt 12; $attempt++) {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object {
    $_.CommandLine -like "*browser-profile*" -or $_.CommandLine -like "*naukri-profile*" -or $_.CommandLine -like "*playwright*"
  }
  foreach ($p in $procs) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) {
      [WinWindow]::ShowWindowAsync($proc.MainWindowHandle, 9)
      [WinWindow]::ShowWindowAsync($proc.MainWindowHandle, 3)
      [WinWindow]::BringWindowToTop($proc.MainWindowHandle)
      [WinWindow]::keybd_event(0x12, 0, 0, 0)
      [WinWindow]::keybd_event(0x12, 0, 2, 0)
      [WinWindow]::SwitchToThisWindow($proc.MainWindowHandle, $true)
      [WinWindow]::SetForegroundWindow($proc.MainWindowHandle)
      $activated = $true
      break
    }
  }
  if ($activated) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $activated) {
  $wshell = New-Object -ComObject WScript.Shell
  $wshell.AppActivate('${titleKeyword}')
  $wshell.AppActivate('LinkedIn')
  $wshell.AppActivate('Naukri')
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
}

function cleanupStaleProfileLock(userDataDir: string) {
  try {
    if (process.platform === 'win32') {
      // Terminate any leftover helper processes specifically attached to this user-data-dir
      const dirBase = path.basename(userDataDir);
      const psScript = [
        `$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'"`,
        `$targets = $procs | Where-Object { $_.CommandLine -like "*${dirBase}*" }`,
        `foreach ($t in $targets) { Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ].join('; ');
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, { stdio: 'ignore', timeout: 7000 });
    } else {
      execSync(`pkill -f "${userDataDir}"`, { stdio: 'ignore' });
    }
  } catch {
    // ignore
  }

  // Also remove stale lockfile if left behind
  try {
    const lockPath = path.join(userDataDir, 'lockfile');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // ignore
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
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

export async function launchApplyBrowser(
  userDataDir: string,
  opts: ApplyLaunchOptions = {},
): Promise<BrowserContext> {
  // Reuse active connected browser session if one already exists for this profile
  const existing = await getActiveApplyBrowser(userDataDir);
  const shouldFocus = opts.focus ?? true;
  if (existing) {
    console.log('[apply] reusing existing active browser session');
    if (shouldFocus) {
      bringWindowToFront('Chrome');
    }
    return existing;
  }

  const launchOpts = {
    headless: false,
    viewport: null,
    locale: opts.locale ?? 'en-US',
    extraHTTPHeaders: opts.extraHTTPHeaders ?? DEFAULT_HEADERS,
    args: opts.args ?? BASE_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
  };

  try {
    const ctx = await tryLaunchPersistent(userDataDir, {
      ...launchOpts,
      channel: 'chrome',
      ignoreDefaultArgs: [...launchOpts.ignoreDefaultArgs, '--no-sandbox'],
    });
    console.log('[apply] launched real Chrome (channel=chrome)');
    try {
      await ctx.addInitScript(() => {
        try {
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
      }
    });
    if (shouldFocus) {
      bringWindowToFront('Chrome');
    }
    return ctx;
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/RESULT_CODE_PROFILE_IN_USE|process did exit|browser has been closed|Target page, context or browser has been closed/i.test(msg)) {
      throw new Error(PROFILE_IN_USE_ERROR);
    }
    console.warn(
      `[apply] real Chrome unavailable (${(err as Error).message || 'unknown error'}) — falling back to bundled Chromium`,
    );
    const fallbackCtx = await tryLaunchPersistent(userDataDir, launchOpts);
    try {
      await fallbackCtx.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        } catch {}
      });
    } catch {}
    g.__hiresignal_activeContext = fallbackCtx;
    g.__hiresignal_activeUserDataDir = userDataDir;
    fallbackCtx.on('close', () => {
      if (g.__hiresignal_activeContext === fallbackCtx) {
        g.__hiresignal_activeContext = null;
        g.__hiresignal_activeUserDataDir = null;
      }
    });
    if (shouldFocus) {
      bringWindowToFront('Chromium');
    }
    return fallbackCtx;
  }
}