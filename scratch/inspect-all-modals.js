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

  const d = page.locator('dialog, [role="dialog"]').first();
  await d.locator('input[type="tel"], input[type="text"]').first().fill('6383827363');
  await d.locator('footer button:has-text("Next"), button:has-text("Next")').first().click();
  await page.waitForTimeout(2500);

  // Now inspect all candidate modals
  const modals = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], .jobs-easy-apply-modal, .artdeco-modal'));
    return candidates.map((el, i) => ({
      index: i,
      tag: el.tagName,
      className: el.className,
      id: el.id,
      role: el.getAttribute('role'),
      ariaModal: el.getAttribute('aria-modal'),
      visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      textSnippet: el.innerText ? el.innerText.replace(/\s+/g, ' ').slice(0, 150) : '',
      buttonCount: el.querySelectorAll('button').length,
      buttons: Array.from(el.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean)
    }));
  });

  console.log('ALL MATCHING MODALS ON STEP 2:', JSON.stringify(modals, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
