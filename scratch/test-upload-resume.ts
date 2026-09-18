import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  await applyBtn.click({ force: true });
  await page.waitForTimeout(2000);

  const modal = page.locator('dialog, [role="dialog"][aria-modal="true"]').first();
  const phone = modal.locator('input[type="tel"]').first();
  if (await phone.count() > 0) {
    await phone.fill('6383827363');
  }

  const nextBtn = modal.locator('footer button').filter({ hasText: /التالي|Next|المتابعة/ }).first();
  await nextBtn.click();
  await page.waitForTimeout(3000);

  // Find upload button: "تحميل السيرة الذاتية" or "Upload resume"
  const uploadBtn = modal.locator('button:has-text("تحميل السيرة الذاتية"), button:has-text("Upload resume")').first();
  console.log('Upload button count:', await uploadBtn.count());

  if (await uploadBtn.count() > 0) {
    // Check if clicking it triggers filechooser
    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await uploadBtn.click();
    const fileChooser = await fileChooserPromise;
    console.log('File chooser intercepted?', fileChooser !== null);
    if (fileChooser) {
      // Test attaching dummy file
      const dummyPath = path.join(process.cwd(), 'scratch', 'dummy.pdf');
      if (!fs.existsSync(dummyPath)) fs.writeFileSync(dummyPath, '%PDF-1.4 dummy');
      await fileChooser.setFiles(dummyPath);
      console.log('Set files via fileChooser!');
    }
  }

  await page.waitForTimeout(2000);
  await ctx.close();
})();
