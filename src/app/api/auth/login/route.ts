import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { launchApplyBrowser, bringWindowToFront, cleanupStaleProfileLock } from '@/lib/apply/launcher';
import { clearPlatformSession } from '@/lib/apply/auth-session';

// Use the persistent profile where auto-apply and ingest scripts look for cookies
const PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

/**
 * Copies Google account preferences and configuration from the user's real Chrome
 * profile into the HireMe browser profile so 'Continue with Google' recognizes
 * already-signed-in accounts on the system.
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

/**
 * Ensure `profile.last_used` is set to 'Default' in `Local State` JSON file
 */
function resetProfileLastUsed(targetDir: string) {
  try {
    const localStatePath = path.join(targetDir, 'Local State');
    let obj: any = {};
    if (fs.existsSync(localStatePath)) {
      try {
        obj = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
      } catch {}
    }
    if (!obj || typeof obj !== 'object') obj = {};
    if (!obj.profile || typeof obj.profile !== 'object') obj.profile = {};
    obj.profile.last_used = 'Default';
    fs.writeFileSync(localStatePath, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[auth/login] Failed to reset profile last_used in Local State:', err);
  }
}

/**
 * Find the system Chrome binary path
 */
function findChromeExecutable(): string | null {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const candidates = [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  } else if (process.platform === 'darwin') {
    const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(macPath)) return macPath;
    return null;
  } else {
    for (const bin of ['/usr/bin/google-chrome', '/usr/bin/chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
      if (fs.existsSync(bin)) return bin;
    }
    return null;
  }
}

/**
 * Detached PowerShell focus helper that finds Chrome window (class Chrome_WidgetWin_1) for target PID
 * and brings it to the front using Win32 API
 */
function spawnChromeFocusHelper(pid: number) {
  if (process.platform !== 'win32') return;
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

    public static bool ForceForegroundByPid(uint targetPid) {
        bool focused = false;
        EnumWindows((hwnd, lParam) => {
            StringBuilder sbClass = new StringBuilder(256);
            GetClassName(hwnd, sbClass, 256);
            if (sbClass.ToString() == "Chrome_WidgetWin_1") {
                uint procId;
                GetWindowThreadProcessId(hwnd, out procId);
                if (targetPid == 0 || procId == targetPid) {
                    try {
                        SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, 0x0002);
                        uint fgProcId;
                        uint fgThreadId = GetWindowThreadProcessId(GetForegroundWindow(), out fgProcId);
                        uint curThreadId = GetCurrentThreadId();
                        if (fgThreadId != 0 && fgThreadId != curThreadId) {
                            AttachThreadInput(curThreadId, fgThreadId, true);
                        }
                        if (IsIconic(hwnd)) {
                            ShowWindow(hwnd, 9);
                        }
                        ShowWindow(hwnd, 5);
                        ShowWindow(hwnd, 3);
                        keybd_event(0x12, 0, 0, 0);
                        keybd_event(0x12, 0, 2, 0);
                        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                        BringWindowToTop(hwnd);
                        SetForegroundWindow(hwnd);
                        SwitchToThisWindow(hwnd, true);
                        if (fgThreadId != 0 && fgThreadId != curThreadId) {
                            AttachThreadInput(curThreadId, fgThreadId, false);
                        }
                        focused = true;
                    } catch {}
                }
            }
            return true;
        }, IntPtr.Zero);
        return focused;
    }
}
"@

$targetPid = ${pid}
for ($i = 0; $i -lt 15; $i++) {
    if ([WinWindowFocus]::ForceForegroundByPid($targetPid)) { break }
    Start-Sleep -Milliseconds 300
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
  resetProfileLastUsed(PROFILE_DIR);

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

  // 3. Launch native Chrome using Node.js spawn with required flags
  const chromePath = findChromeExecutable();
  if (chromePath) {
    try {
      const child = spawn(
        chromePath,
        [
          `--user-data-dir=${PROFILE_DIR}`,
          '--new-window',
          '--no-first-run',
          '--no-default-browser-check',
          '--start-maximized',
          targetUrl,
        ],
        {
          detached: true,
          stdio: 'ignore',
        }
      );

      const pid = child.pid || 0;
      child.unref();

      spawnChromeFocusHelper(pid);

      return NextResponse.json({
        ok: true,
        platform,
        message: `Chrome opened at ${platform === 'naukri' ? 'Naukri' : 'LinkedIn'} login page. Please sign in in Chrome.`,
      });
    } catch (err) {
      console.warn('[api/auth/login] Native Chrome spawn failed, falling back to launchApplyBrowser:', err);
    }
  }

  // Fallback if native Chrome binary wasn't found or spawn failed
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
