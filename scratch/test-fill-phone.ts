import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  await applyBtn.click({ force: true });
  await page.waitForTimeout(3000);

  // Fill phone input directly via input[type="tel"]
  const phoneInput = page.locator('input[type="tel"]').first();
  console.log('Phone input found:', await phoneInput.count());
  await phoneInput.fill('9500000000');
  console.log('Filled phone input!');
  await page.waitForTimeout(1000);

  // Click Next button
  const nextBtn = page.locator('button:has-text("التالي"), button:has-text("Next"), [role="dialog"] button:has-text("التالي")').first();
  console.log('Clicking next...');
  await nextBtn.click();
  await page.waitForTimeout(3500);

  const screenshotPath = path.join(process.cwd(), 'scratch', 'step-after-phone.png');
  await page.screenshot({ path: screenshotPath });
  console.log('Saved screenshot to:', screenshotPath);

  await ctx.close();
})();
