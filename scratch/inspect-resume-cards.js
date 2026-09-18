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

  const resumeCards = await page.evaluate(() => {
    const dialog = document.querySelector('dialog, [role="dialog"]');
    if (!dialog) return { error: 'no dialog' };

    // Find all items that might be resume selections
    const items = Array.from(dialog.querySelectorAll('li, div[role="radio"], label, input[type="radio"], [data-test-resume-item]')).map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      ariaChecked: el.getAttribute('aria-checked'),
      ariaSelected: el.getAttribute('aria-selected'),
      className: el.className,
      text: el.textContent?.trim().slice(0, 100)
    })).filter(x => x.text && x.text.includes('.pdf'));

    return { items };
  });

  console.log('RESUME CARDS:', JSON.stringify(resumeCards, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
