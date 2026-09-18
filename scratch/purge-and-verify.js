const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });

  // 1. Read all cookies
  const allCookies = await ctx.cookies();
  console.log('Total cookies before purge:', allCookies.length);

  // 2. Filter out ALL lang and locale cookies
  const keepCookies = allCookies.filter(c => c.name !== 'lang' && c.name !== 'UserLocale');
  console.log('Cookies keeping (including login auth):', keepCookies.length);

  // 3. Clear all cookies
  await ctx.clearCookies();

  // 4. Re-add kept cookies
  await ctx.addCookies(keepCookies);

  // 5. Add pure English cookies
  const englishCookies = [
    { name: 'lang', value: 'v=2&lang=en-us', domain: '.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: 'www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: '.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: 'www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
  ];
  await ctx.addCookies(englishCookies);

  // 6. Verify cookies in profile
  const afterCookies = await ctx.cookies(['https://www.linkedin.com', 'https://linkedin.com']);
  const langCookies = afterCookies.filter(c => /lang|locale/i.test(c.name));
  console.log('VERIFIED LANG COOKIES AFTER PURGE:', JSON.stringify(langCookies, null, 2));

  // 7. Open job page and verify
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const pageCheck = await page.evaluate(() => ({
    title: document.title,
    htmlLang: document.documentElement.getAttribute('lang'),
    htmlDir: document.documentElement.getAttribute('dir'),
    easyApplyText: document.querySelector('.jobs-apply-button, button[data-job-id]')?.textContent?.trim()
  }));

  console.log('JOB PAGE AFTER PURGE:', JSON.stringify(pageCheck, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
