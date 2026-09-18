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
  
  console.log('Clicking Next on Step 1...');
  await d.locator('footer button:has-text("Next"), button:has-text("Next")').first().click();
  await page.waitForTimeout(2500);

  console.log('Step 2 (Resume) loaded. Inspecting...');
  const info = await page.evaluate(() => {
    const dialog = document.querySelector('dialog, [role="dialog"]');
    if (!dialog) return { error: 'no dialog' };

    const fileInputs = Array.from(dialog.querySelectorAll('input[type="file"]')).map(f => ({
      accept: f.accept,
      id: f.id,
      name: f.name
    }));

    const text = dialog.innerText;
    const nextBtn = Array.from(dialog.querySelectorAll('button')).find(b => /next/i.test(b.innerText || ''));

    return {
      fileInputs,
      nextBtnFound: !!nextBtn,
      nextBtnDisabled: nextBtn ? nextBtn.disabled : null,
      nextBtnText: nextBtn ? nextBtn.innerText : null,
      dialogTextSnippet: text.slice(0, 600)
    };
  });

  console.log('STEP 2 INSPECTION:', JSON.stringify(info, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
