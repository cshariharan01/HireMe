const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'test-prof-visible');
  console.log('Launching without channel: chrome (bundled Chromium)...');
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  console.log('Bundled Chromium launched.');
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.google.com');
  console.log('Page loaded in Chromium.');
  await new Promise(r => setTimeout(r, 5000));
  await ctx.close();
})();
