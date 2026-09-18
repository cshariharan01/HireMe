const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });
  const cookies = await ctx.cookies(['https://www.linkedin.com', 'https://linkedin.com']);
  const langCookies = cookies.filter(c => /lang|locale/i.test(c.name));
  console.log('LANG/LOCALE COOKIES IN PROFILE:', JSON.stringify(langCookies, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
