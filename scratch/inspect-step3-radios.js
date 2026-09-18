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
  await page.waitForTimeout(2000);

  await d.locator('footer button:has-text("Next"), button:has-text("Next")').first().click();
  await page.waitForTimeout(2000);

  // Step 3: Click the first role="radio" inside fieldset (which is "Yes")
  console.log('Clicking Yes via role="radio"...');
  const yesRadio = d.locator('fieldset [role="radio"]').first();
  await yesRadio.click();
  console.log('Clicked role="radio"');

  // Fill the 2 numeric questions
  const numInputs = d.locator('input[type="text"]');
  const count = await numInputs.count();
  for (let i = 0; i < count; i++) {
    await numInputs.nth(i).fill('3');
  }
  console.log('Filled numeric questions with 3');

  await page.waitForTimeout(1000);

  // Click Review
  console.log('Clicking Review button on Step 3...');
  await d.locator('footer button:has-text("Review"), button:has-text("Review")').first().click();
  await page.waitForTimeout(4000);

  // Take screenshot of step 4!
  await page.screenshot({ path: 'scratch/final-review-proof.png' });
  console.log('Saved final-review-proof.png!');

  const finalCheck = await page.evaluate(() => {
    const dialog = document.querySelector('dialog, [role="dialog"]');
    const submitBtn = Array.from(dialog ? dialog.querySelectorAll('button') : []).find(b => /submit/i.test(b.innerText || b.getAttribute('aria-label') || ''));
    return {
      title: document.title,
      htmlLang: document.documentElement.getAttribute('lang'),
      htmlDir: document.documentElement.getAttribute('dir'),
      header: dialog ? dialog.querySelector('h3, h2, h4')?.textContent?.trim() : null,
      modalSnippet: dialog ? dialog.textContent?.replace(/\s+/g, ' ').slice(0, 500) : null,
      submitFound: !!submitBtn,
      submitText: submitBtn ? submitBtn.innerText.trim() : null,
      allButtons: Array.from(dialog ? dialog.querySelectorAll('button') : []).map(b => b.innerText.trim()).filter(Boolean)
    };
  });
  console.log('FINAL REVIEW CHECK:', JSON.stringify(finalCheck, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
