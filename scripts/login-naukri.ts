import './shared/env';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { execSync, spawn } from 'child_process';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

const PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

function cleanupProcesses(userDataDir: string) {
  try {
    if (process.platform === 'win32') {
      const searchPattern = userDataDir.replace(/\\/g, '*');
      const cmd = `Get-WmiObject Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*${searchPattern}*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
      execSync(`powershell -NoProfile -NonInteractive -Command "${cmd}"`, { stdio: 'ignore', timeout: 5000 });
    }
  } catch {
    // ignore
  }
}

function getChromeExecutable(): string | null {
  const candidates = [
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function main() {
  if (process.argv.includes('--reset')) {
    console.log('Resetting browser profile...');
    cleanupProcesses(PROFILE_DIR);
    await new Promise((r) => setTimeout(r, 1000));
    if (fs.existsSync(PROFILE_DIR)) {
      try {
        fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
        console.log('✓ Profile cleared completely.');
      } catch (err) {
        console.warn('Note: Some locked cache files were kept, but credentials will be reset.');
      }
    }
  }

  const chromePath = getChromeExecutable();
  let chromeProc: ReturnType<typeof spawn> | null = null;
  let browser: any = null;

  if (chromePath) {
    console.log(`Launching native Google Chrome (${chromePath})...`);
    console.log('(Running native browser without automation hooks so Google OAuth is fully allowed)\n');
    chromeProc = spawn(
      chromePath,
      [
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        'https://www.naukri.com/nlogin/login',
      ],
      { detached: false, stdio: 'ignore' }
    );
  } else {
    console.log('Launching Google Chrome via Playwright launcher...');
    browser = await launchApplyBrowser(PROFILE_DIR, {
      locale: 'en-IN',
      args: ['--start-maximized'],
    });
    const page = browser.pages()[0] || (await browser.newPage());
    await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded' });
  }

  console.log('======================================================');
  console.log('Google Chrome is now open at the Naukri login page.');
  console.log('Please log into your correct Naukri account in Chrome.');
  console.log('Once you are logged in, press ENTER in this terminal to save.');
  console.log('======================================================\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question('Press ENTER when you have logged in... ', () => {
      rl.close();
      resolve();
    });
  });

  console.log('Session saved to profile!');
  if (browser) {
    await browser.close();
  } else if (chromeProc) {
    console.log('You can now close the login Chrome window or leave it as is.');
  }
}

main().catch((err) => {
  console.error('Login error:', err);
  process.exit(1);
});
