const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.locator('.jobs-apply-button, button:has-text("Easy Apply")').first().click();
  await page.waitForTimeout(2000);

  const d = page.locator('dialog').first();
  console.log('dialog count:', await d.count());
  console.log('dialog isVisible():', await d.isVisible());
  console.log('dialog.evaluate rect:', await d.evaluate(el => ({
    width: el.getBoundingClientRect().width,
    height: el.getBoundingClientRect().height,
    hasOpenAttr: el.hasAttribute('open'),
    openProp: el.open
  })));

  await ctx.close();
})().catch(e => console.error(e));
