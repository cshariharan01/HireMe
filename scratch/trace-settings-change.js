const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('settingsApiSettings') || url.includes('interfaceLocale') || url.includes('accountPreferences')) {
      console.log('SETTINGS RESPONSE:', resp.status(), url);
      try {
        console.log('BODY:', await resp.text());
      } catch {}
      const setCookie = resp.headers()['set-cookie'];
      if (setCookie) console.log('SET-COOKIE:', setCookie);
    }
  });

  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  console.log('Current value before:', await page.evaluate(() => document.querySelector('select')?.value));

  // Focus and select option
  const sel = page.locator('select');
  await sel.scrollIntoViewIfNeeded();
  await sel.selectOption('en_US');
  await sel.dispatchEvent('change');
  console.log('Dispatched change event.');

  // Wait 10s
  await page.waitForTimeout(10000);

  console.log('Current value after 10s:', await page.evaluate(() => document.querySelector('select')?.value));

  // Navigate to another page within the site
  console.log('Navigating to feed/home...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  console.log('Feed title:', await page.title());
  console.log('Feed lang:', await page.evaluate(() => document.documentElement.getAttribute('lang')));
  console.log('Feed dir:', await page.evaluate(() => document.documentElement.getAttribute('dir')));

  // Now navigate back to settings
  console.log('Navigating back to language settings...');
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  console.log('Settings value on revisit:', await page.evaluate(() => document.querySelector('select')?.value));

  await ctx.close();
})().catch(e => console.error(e));
