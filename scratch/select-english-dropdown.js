const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false, // visible so we see it happen
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Find the select element
  const select = page.locator('select').first();
  console.log('Select count:', await select.count());

  // Log all options in the select
  const options = await page.evaluate(() => {
    const s = document.querySelector('select');
    if (!s) return [];
    return Array.from(s.options).map(o => ({ value: o.value, text: o.text, selected: o.selected }));
  });
  console.log('Options in select:', JSON.stringify(options, null, 2));

  // Select en_US
  console.log('Selecting en_US...');
  await select.selectOption('en_US');
  await page.waitForTimeout(3000);

  // Check if there is a save/confirm button or toast
  const saveBtn = page.locator('button:has-text("Save"), button:has-text("حفظ")').first();
  if ((await saveBtn.count()) > 0 && (await saveBtn.isVisible().catch(() => false))) {
    console.log('Clicking Save...');
    await saveBtn.click();
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: 'scratch/settings-after-select.png' });
  console.log('Saved settings-after-select.png');

  // Verify by navigating to feed
  console.log('Navigating to feed to verify language...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const feedState = await page.evaluate(() => ({
    htmlLang: document.documentElement.getAttribute('lang'),
    htmlDir: document.documentElement.getAttribute('dir'),
    title: document.title,
  }));
  console.log('Feed State after language change:', JSON.stringify(feedState, null, 2));
  await page.screenshot({ path: 'scratch/feed-after-change.png' });

  await ctx.close();
})().catch(e => console.error(e));
