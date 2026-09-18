import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Step 1: Open modal
  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  await applyBtn.click({ force: true });
  await page.waitForTimeout(2000);

  const modal = page.locator('dialog, [role="dialog"][aria-modal="true"]').first();
  const phone = modal.locator('input[type="tel"]').first();
  if (await phone.count() > 0) {
    await phone.fill('6383827363');
  }

  // Next to Step 2
  const nextBtn = modal.locator('footer button').filter({ hasText: /التالي|Next|المتابعة/ }).first();
  await nextBtn.click();
  await page.waitForTimeout(2500);

  // Next to Step 3 (Resume is already selected)
  const nextBtn2 = modal.locator('footer button').filter({ hasText: /التالي|Next|المتابعة/ }).first();
  console.log('Step 2 Next button count:', await nextBtn2.count());
  await nextBtn2.click();
  await page.waitForTimeout(3000);

  // Check Step 3
  const step3Text = await modal.evaluate(el => el.innerText.slice(0, 300));
  console.log('Step 3 text preview:\n', step3Text);

  await page.screenshot({ path: path.join(process.cwd(), 'scratch', 'step3.png') });

  // Next to Step 4
  const nextBtn3 = modal.locator('footer button').filter({ hasText: /التالي|Next|المتابعة|مراجعة|Review/ }).first();
  console.log('Step 3 Next button count:', await nextBtn3.count());
  if (await nextBtn3.count() > 0) {
    await nextBtn3.click();
    await page.waitForTimeout(3000);
    const step4Text = await modal.evaluate(el => el.innerText.slice(0, 300));
    console.log('Step 4 text preview:\n', step4Text);
    await page.screenshot({ path: path.join(process.cwd(), 'scratch', 'step4.png') });
  }

  await ctx.close();
})();
