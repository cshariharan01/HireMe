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
  await applyBtn.click({ force: true });
  await page.waitForTimeout(3000);

  // Fill phone input
  const phoneInput = page.locator('input[type="tel"]').first();
  await phoneInput.fill('6383827363');
  await page.waitForTimeout(1000);

  // Click Next button
  const nextBtn = page.locator('[role="dialog"] button:has-text("التالي"), [role="dialog"] button:has-text("Next"), button:has-text("التالي")').first();
  await nextBtn.click();
  await page.waitForTimeout(3000);

  // Find all dialogs
  const dialogs = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'));
    return all.map(d => ({
      classes: d.className,
      text: d.textContent?.slice(0, 100),
      buttons: Array.from(d.querySelectorAll('button')).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()),
      fileInputs: d.querySelectorAll('input[type="file"]').length,
    }));
  });
  console.log('All dialogs:', JSON.stringify(dialogs, null, 2));

  // Scroll the modal
  await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll('[role="dialog"]'));
    for (const m of modals) {
      m.scrollTop = m.scrollHeight;
      for (const c of Array.from(m.querySelectorAll('*'))) {
        (c as HTMLElement).scrollTop = (c as HTMLElement).scrollHeight;
      }
    }
  });
  await page.waitForTimeout(1000);

  await page.screenshot({ path: path.join(process.cwd(), 'scratch', 'step2-scrolled.png') });
  console.log('Saved step2-scrolled.png');

  await ctx.close();
})();
