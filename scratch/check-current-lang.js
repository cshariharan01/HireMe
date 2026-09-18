const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    const s = document.querySelector('select');
    return {
      selectValue: s ? s.value : null,
      selectedOptionText: s && s.selectedOptions[0] ? s.selectedOptions[0].text : null,
      htmlLang: document.documentElement.getAttribute('lang'),
      htmlDir: document.documentElement.getAttribute('dir'),
    };
  });

  console.log('CURRENT SETTINGS STATE:', JSON.stringify(state, null, 2));
  await ctx.close();
})().catch(e => console.error(e));
