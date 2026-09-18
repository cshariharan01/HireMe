const { chromium } = require('playwright');

(async () => {
  const ctx = await chromium.launchPersistentContext('data/playwright/browser-profile', {
    channel: 'chrome',
    headless: true,
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  // Check current cookies
  const allCookies = await ctx.cookies();
  console.log('All cookies count:', allCookies.length);
  const linkedinCookies = allCookies.filter(c => c.domain.includes('linkedin'));
  console.log('LinkedIn cookies:', linkedinCookies.map(c => `${c.name}@${c.domain}=${c.value.slice(0, 25)}`));

  // Let's test deleting cookies one by one or testing with specific cookies
  // Try setting lang cookie to en-us on .linkedin.com
  await ctx.addCookies([
    { name: 'lang', value: 'v=2&lang=en-us', domain: '.linkedin.com', path: '/' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: 'www.linkedin.com', path: '/' },
  ]);

  await page.goto('https://www.linkedin.com/jobs/view/4465714034/');
  await page.waitForTimeout(2000);
  console.log('Step 1 Lang:', await page.evaluate(() => document.documentElement.getAttribute('lang')));

  // What if we delete ALL linkedin cookies?
  await ctx.clearCookies();
  await page.goto('https://www.linkedin.com/jobs/view/4465714034/');
  await page.waitForTimeout(2000);
  console.log('Step 2 Lang after clearCookies:', await page.evaluate(() => document.documentElement.getAttribute('lang')));

  await ctx.close();
})();
