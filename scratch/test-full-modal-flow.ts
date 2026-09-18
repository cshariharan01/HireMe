import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  console.log('Navigating to', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // 1. Click Easy Apply
  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  console.log('Apply button count:', await applyBtn.count());
  await applyBtn.click({ force: true });
  await page.waitForTimeout(2000);

  // 2. Locate dialog
  const modal = page.locator('dialog, [role="dialog"][aria-modal="true"], .jobs-easy-apply-modal').first();
  console.log('Modal count:', await modal.count());

  // 3. Fill phone if on contact info step
  const phone = modal.locator('input[type="tel"], input[id*="phone" i], input[name*="phone" i]').first();
  console.log('Phone count:', await phone.count());
  if (await phone.count() > 0) {
    const val = await phone.inputValue();
    console.log('Current phone value:', val);
    if (!val) {
      await phone.fill('6383827363');
      console.log('Filled phone: 6383827363');
    }
  }

  // 4. Click Next
  const nextBtn = modal.locator('button:has-text("التالي"), button:has-text("Next"), footer button').filter({ hasText: /التالي|Next|المتابعة/ }).first();
  console.log('Next button count:', await nextBtn.count());
  await nextBtn.click();
  console.log('Clicked Next!');
  await page.waitForTimeout(3000);

  // 5. Check Step 2 contents
  const step2Text = await modal.evaluate(el => el.innerText.slice(0, 300));
  console.log('Step 2 text preview:\n', step2Text);

  // Check file input inside modal
  const fileInput = modal.locator('input[type="file"]').first();
  console.log('Step 2 file input count:', await fileInput.count());

  // Check next button on step 2
  const step2NextBtn = modal.locator('button:has-text("التالي"), button:has-text("Next"), footer button').filter({ hasText: /التالي|Next|المتابعة|مراجعة|Review/ }).first();
  console.log('Step 2 Next button count:', await step2NextBtn.count());
  if (await step2NextBtn.count() > 0) {
    console.log('Step 2 Next button text:', await step2NextBtn.innerText());
  }

  await ctx.close();
})();
