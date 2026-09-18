const { chromium } = require('playwright');
const path = require('path');
const { execSync } = require('child_process');

const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  console.log('Closing any open chrome instances on profile...');
  try {
    const ps = `$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*browser-profile*' }; foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`);
  } catch {}

  await new Promise(r => setTimeout(r, 1500));

  console.log('Launching browser to fix language...');
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
  });

  const page = ctx.pages()[0] || await ctx.newPage();

  console.log('Navigating to LinkedIn language preferences...');
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  console.log('Current URL:', page.url());
  console.log('Current Title:', await page.title());

  // Look for English language radio option
  const switched = await page.evaluate(() => {
    // Look for all elements that contain English
    const candidates = Array.from(document.querySelectorAll('label, input, span, div, li, [role="radio"]'));
    const englishOption = candidates.find(el => {
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
      return /English/i.test(text);
    });
    if (englishOption) {
      englishOption.click();
      return { success: true, text: englishOption.innerText };
    }
    return { success: false };
  });

  console.log('Switch attempt:', switched);
  await page.waitForTimeout(5000);

  console.log('Page Title after switch:', await page.title());
  console.log('Page HTML lang after switch:', await page.evaluate(() => document.documentElement.getAttribute('lang')));

  // Now test visiting a job posting to verify English
  console.log('Testing job posting language...');
  await page.goto('https://www.linkedin.com/jobs/view/4440422331/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  console.log('Job URL:', page.url());
  console.log('Job Title:', await page.title());
  console.log('Job Lang:', await page.evaluate(() => document.documentElement.getAttribute('lang')));
  console.log('Job Dir:', await page.evaluate(() => document.documentElement.getAttribute('dir')));

  await ctx.close();
  console.log('Language fix script completed!');
})().catch(err => console.error('Language fix error:', err));
