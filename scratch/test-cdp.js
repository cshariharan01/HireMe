const { execSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

async function waitForPort(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error('status ' + res.statusCode));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

(async () => {
  console.log('Testing CDP launch on WinSta0\\Default...');
  const port = 9222;
  const userDataDir = path.resolve('data/playwright/browser-profile');
  
  // First kill any existing chrome on this profile
  try {
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*browser-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`);
  } catch {}

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=\\"${userDataDir}\\"`,
    '--new-window',
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    'about:blank'
  ].join(' ');

  // Launch via DesktopSpawner to ensure it opens on WinSta0\\Default
  const psOut = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File scratch/run-spawner.ps1 -appPath "${chromePath}" -appArgs "${args.replace(/"/g, '\\"')}"`).toString();
  console.log('Spawner output:', psOut);

  console.log('Waiting for CDP on port', port);
  const ready = await waitForPort(port);
  console.log('Port ready:', ready);

  if (ready) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    console.log('Connected via CDP! Contexts:', browser.contexts().length);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    console.log('Navigating to google.com...');
    await page.goto('https://www.google.com');
    console.log('Page title:', await page.title());
    await new Promise(r => setTimeout(r, 4000));
    await browser.close();
    console.log('Closed successfully!');
  }
})().catch(err => console.error('CDP test error:', err));
