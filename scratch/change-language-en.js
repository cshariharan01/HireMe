const { chromium } = require('playwright');
const path = require('path');
const { execSync } = require('child_process');

const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  try {
    const ps = `$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*browser-profile*' }; foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`);
  } catch {}

  await new Promise(r => setTimeout(r, 1000));

  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('Navigating to settings...');
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const selectInfo = await page.evaluate(() => {
    const opt = document.querySelector('option[value="en_US"]');
    if (!opt) return { found: false };
    const sel = opt.closest('select');
    return {
      found: true,
      selectId: sel ? sel.id : null,
      selectName: sel ? sel.name : null,
      currentValue: sel ? sel.value : null,
      options: sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.text })) : []
    };
  });
  console.log('Select info found:', JSON.stringify({ ...selectInfo, options: selectInfo.options?.slice(0, 5) }, null, 2));

  console.log('Selecting en_US dropdown option...');
  // Use playwright selectOption
  await page.selectOption('select', 'en_US');
  console.log('Option selected, waiting 5 seconds for backend to sync...');
  await page.waitForTimeout(5000);

  console.log('Language page title:', await page.title());
  console.log('Language page lang attribute:', await page.evaluate(() => document.documentElement.getAttribute('lang')));
  console.log('Language page dir attribute:', await page.evaluate(() => document.documentElement.getAttribute('dir')));

  // Now test visiting the job posting
  console.log('\nNavigating to job posting https://www.linkedin.com/jobs/view/4440422331/ ...');
  await page.goto('https://www.linkedin.com/jobs/view/4440422331/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const jobDetails = await page.evaluate(() => {
    const easyApplyBtn = document.querySelector('.jobs-apply-button, button[data-job-id]');
    const navItems = Array.from(document.querySelectorAll('.global-nav__primary-link-text')).map(el => el.innerText.trim());
    return {
      title: document.title,
      htmlLang: document.documentElement.getAttribute('lang'),
      htmlDir: document.documentElement.getAttribute('dir'),
      easyApplyButtonText: easyApplyBtn ? easyApplyBtn.innerText.trim() : null,
      navItems: navItems.filter(Boolean),
    };
  });

  console.log('\n--- Job Page Verification ---');
  console.log('Job Page Details:', JSON.stringify(jobDetails, null, 2));

  await page.screenshot({ path: 'scratch/job-page-en.png' });
  console.log('Saved screenshot to scratch/job-page-en.png');

  await ctx.close();
  console.log('\nDone!');
})().catch(err => {
  console.error('Error during execution:', err);
});
