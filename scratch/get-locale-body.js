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
  await page.waitForTimeout(3000);

  const getBody = await page.evaluate(async () => {
    const csrfMatch = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    const getRes = await fetch('https://www.linkedin.com/mysettings-api/settingsApiSettings/interfaceLocale', {
      headers: {
        'csrf-token': csrf,
        'X-RestLi-Protocol-Version': '2.0.0',
        'Accept': 'application/json'
      }
    });
    return await getRes.json();
  });

  console.log('GET BODY:', JSON.stringify(getBody, null, 2));
  await ctx.close();
})().catch(e => console.error(e));
