const { chromium } = require('playwright');
const path = require('path');

(async () => {
  console.log('Testing launchPersistentContext without channel: chrome...');
  const profile1 = path.join(process.cwd(), 'data', 'test-prof-1');
  const ctx1 = await chromium.launchPersistentContext(profile1, {
    headless: false,
    viewport: null,
  });
  console.log('Launched default Chromium.');
  const page1 = ctx1.pages()[0] || await ctx1.newPage();
  await page1.goto('https://www.google.com');

  const { execSync } = require('child_process');
  const out1 = execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle -like '*Google*' } | Select-Object Id, ProcessName, MainWindowTitle"`).toString();
  console.log('Windows matching Google for default Chromium:\n', out1);

  await ctx1.close();

  console.log('\nTesting launchPersistentContext WITH channel: chrome...');
  const profile2 = path.join(process.cwd(), 'data', 'test-prof-2');
  const ctx2 = await chromium.launchPersistentContext(profile2, {
    channel: 'chrome',
    headless: false,
    viewport: null,
  });
  console.log('Launched real Chrome.');
  const page2 = ctx2.pages()[0] || await ctx2.newPage();
  await page2.goto('https://www.google.com');

  const out2 = execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle -like '*Google*' } | Select-Object Id, ProcessName, MainWindowTitle"`).toString();
  console.log('Windows matching Google for real Chrome:\n', out2);

  await ctx2.close();
})();
