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

  // Helper to find the real Easy Apply dialog
  const getDialog = () => page.locator('dialog').first();

  // Helper to wait for and click next
  async function advanceNext(stepName) {
    console.log(`[advance] Waiting for next/review button on ${stepName}...`);
    const d = getDialog();
    const btn = d.locator('footer button:has-text("Next"), footer button:has-text("Review"), button:has-text("Next"), button:has-text("Review")').first();
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    
    // Wait for enabled
    for (let w = 0; w < 10; w++) {
      if (!(await btn.isDisabled())) break;
      await page.waitForTimeout(500);
    }
    const label = await btn.innerText();
    console.log(`[advance] Clicking "${label}" on ${stepName}...`);
    await btn.click();
    await page.waitForTimeout(2000);
  }

  // Step 1: Contact info
  const d = getDialog();
  await d.locator('input[type="tel"], input[type="text"]').first().fill('6383827363');
  await advanceNext('Step 1 (Contact)');

  // Step 2: Resume (already selected)
  await advanceNext('Step 2 (Resume)');

  // Step 3: Questions
  console.log('[advance] Answering Step 3 questions...');
  const yesRadio = d.locator('fieldset [role="radio"]').first();
  if ((await yesRadio.count()) > 0) {
    await yesRadio.click();
    console.log('[advance] Clicked Yes radio');
  }
  const textInputs = d.locator('input[type="text"]');
  const count = await textInputs.count();
  for (let i = 0; i < count; i++) {
    await textInputs.nth(i).fill('3');
  }
  console.log(`[advance] Filled ${count} text inputs with 3`);

  await advanceNext('Step 3 (Questions)');

  // Step 4: Final Review!
  console.log('[advance] Checking Step 4 (Final Review)...');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'scratch/clean-step4-proof.png' });

  const reviewInfo = await page.evaluate(() => {
    const dialog = document.querySelector('dialog');
    const submitBtn = dialog ? Array.from(dialog.querySelectorAll('button')).find(b => /submit/i.test(b.innerText || '')) : null;
    return {
      title: document.title,
      htmlLang: document.documentElement.getAttribute('lang'),
      htmlDir: document.documentElement.getAttribute('dir'),
      header: dialog ? dialog.querySelector('h3, h2, h4')?.textContent?.trim() : null,
      pageCount: dialog ? dialog.innerText.match(/\d\/\d\s*pages/i)?.[0] : null,
      submitFound: !!submitBtn,
      submitText: submitBtn ? submitBtn.innerText.trim() : null
    };
  });

  console.log('STEP 4 REVIEW INFO:', JSON.stringify(reviewInfo, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
