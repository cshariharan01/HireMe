import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('Landing lang:', await page.evaluate(() => document.documentElement.getAttribute('lang')));
    console.log('Landing dir:', await page.evaluate(() => document.documentElement.getAttribute('dir')));

    // Click easy apply
    const btn = page.locator('button:has-text("Easy Apply"), button:has-text("التقديم السريع")').first();
    await btn.click();
    await page.waitForTimeout(2000);

    console.log('Step 1 modal text:', await page.evaluate(() => document.querySelector('.jobs-easy-apply-modal')?.textContent?.slice(0, 200)));
    console.log('Step 1 lang:', await page.evaluate(() => document.documentElement.getAttribute('lang')));
    console.log('Step 1 dir:', await page.evaluate(() => document.documentElement.getAttribute('dir')));

    // Click Next
    const nextBtn = page.locator('.jobs-easy-apply-modal button:has-text("Next"), .jobs-easy-apply-modal button:has-text("التالي")').first();
    if (await nextBtn.isVisible()) {
      await nextBtn.click();
      await page.waitForTimeout(3000);
    }

    console.log('Step 2 modal text:', await page.evaluate(() => document.querySelector('.jobs-easy-apply-modal')?.textContent?.slice(0, 300)));
    console.log('Step 2 lang:', await page.evaluate(() => document.documentElement.getAttribute('lang')));
    console.log('Step 2 dir:', await page.evaluate(() => document.documentElement.getAttribute('dir')));
    console.log('Modal dir:', await page.evaluate(() => document.querySelector('.jobs-easy-apply-modal')?.getAttribute('dir')));

    await page.screenshot({ path: 'scratch/step2-inspect.png' });
    console.log('Screenshot saved to scratch/step2-inspect.png');
  } finally {
    await ctx.close();
  }
})().catch(e => console.error(e));
