import path from 'path';
import fs from 'fs';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  console.log('applyBtn count:', await applyBtn.count());
  await applyBtn.click({ force: true });
  await page.waitForTimeout(3000);

  // Fill phone input
  const phoneInput = page.locator('input[type="tel"]').first();
  console.log('phoneInput count:', await phoneInput.count());
  await phoneInput.fill('6383827363');
  await page.waitForTimeout(1000);

  // Take screenshot of step 1 filled
  await page.screenshot({ path: path.join(process.cwd(), 'scratch', 'check-step1.png') });

  // Click Next button inside dialog footer or dialog
  const nextBtn = page.locator('[role="dialog"] button:has-text("التالي"), [role="dialog"] button:has-text("Next"), button:has-text("التالي")').first();
  console.log('nextBtn count:', await nextBtn.count());
  await nextBtn.click();
  await page.waitForTimeout(4000);

  // Take screenshot after clicking next
  await page.screenshot({ path: path.join(process.cwd(), 'scratch', 'check-step2.png') });

  // Now dump all elements inside [role="dialog"]
  const dialogHtml = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerHTML : 'NO DIALOG FOUND';
  });
  console.log('Dialog HTML length:', dialogHtml.length);
  fs.writeFileSync(path.join(process.cwd(), 'scratch', 'dialog.html'), dialogHtml);

  await ctx.close();
})();
