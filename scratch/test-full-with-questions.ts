import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 1. Click Easy Apply
  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  await applyBtn.click({ force: true });
  await page.waitForTimeout(2000);

  const modal = page.locator('dialog, [role="dialog"][aria-modal="true"]').first();
  // Step 1: Fill phone
  const phone = modal.locator('input[type="tel"]').first();
  if (await phone.count() > 0) {
    await phone.fill('6383827363');
  }

  // Click Next -> Step 2
  let nextBtn = modal.locator('footer button').filter({ hasText: /التالي|Next|المتابعة/ }).first();
  await nextBtn.click();
  await page.waitForTimeout(2500);

  // Step 2: Resume (already selected) -> Click Next -> Step 3
  nextBtn = modal.locator('footer button').filter({ hasText: /التالي|Next|المتابعة/ }).first();
  await nextBtn.click();
  await page.waitForTimeout(2500);

  // Step 3: Questions
  console.log('Filling questions on Step 3...');
  const inputs = await modal.locator('input[type="text"], input:not([type])').all();
  console.log('Found question inputs:', inputs.length);
  for (const inp of inputs) {
    const val = await inp.inputValue();
    if (!val) {
      await inp.fill('3');
      console.log('Filled 3 into input');
    }
  }
  await page.waitForTimeout(1000);

  // Click Next -> Step 4
  nextBtn = modal.locator('footer button').filter({ hasText: /التالي|Next|المتابعة|مراجعة|Review/ }).first();
  console.log('Next button text on step 3:', await nextBtn.innerText());
  await nextBtn.click();
  await page.waitForTimeout(3000);

  // Step 4: Review step!
  const step4Text = await modal.evaluate(el => el.innerText.slice(0, 300));
  console.log('Step 4 text preview:\n', step4Text);
  await page.screenshot({ path: path.join(process.cwd(), 'scratch', 'final-review-step.png') });

  // Check submit button on Step 4
  const submitBtn = modal.locator('footer button').filter({ hasText: /إرسال|Submit/ }).first();
  console.log('Submit button count on step 4:', await submitBtn.count());
  if (await submitBtn.count() > 0) {
    console.log('Submit button text:', await submitBtn.innerText());
  }

  await ctx.close();
})();
