const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
  });

  console.log('Clearing old lang and UserLocale cookies...');
  await ctx.clearCookies({ name: 'lang' });
  await ctx.clearCookies({ name: 'UserLocale' });

  console.log('Adding fresh English cookies...');
  await ctx.addCookies([
    { name: 'lang', value: 'v=2&lang=en-us', domain: '.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: 'www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: '.www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: 'linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: '.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: 'www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: '.www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: 'linkedin.com', path: '/', secure: true, sameSite: 'None' },
  ]);

  const page = ctx.pages()[0] || await ctx.newPage();

  console.log('Navigating to settings to set en_US...');
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const curVal = await page.evaluate(() => document.querySelector('select')?.value);
  console.log('Settings dropdown currently:', curVal);

  if (curVal !== 'en_US') {
    console.log('Updating settings dropdown to en_US...');
    await page.locator('select').selectOption('en_US');
    await page.locator('select').dispatchEvent('change');
    await page.waitForTimeout(5000);
  }

  console.log('Navigating to job posting 4440422331...');
  await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const jobInfo = await page.evaluate(() => {
    return {
      title: document.title,
      lang: document.documentElement.getAttribute('lang'),
      dir: document.documentElement.getAttribute('dir'),
      buttonText: document.querySelector('.jobs-apply-button')?.textContent?.trim(),
    };
  });
  console.log('Job Page Info:', JSON.stringify(jobInfo, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
