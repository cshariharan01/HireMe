import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const btn = page.locator('button:has-text("Easy Apply")').first();
    await btn.click();
    await page.waitForTimeout(2000);

    // Fill phone number if empty
    const phoneInput = page.locator('input[id*="phoneNumber"], input[name*="phoneNumber"], input[type="tel"]').first();
    if (await phoneInput.isVisible()) {
      await phoneInput.fill('9876543210');
    }

    // Click Next
    await page.locator('.jobs-easy-apply-modal button:has-text("Next")').first().click();
    await page.waitForTimeout(3000);

    await page.screenshot({ path: 'scratch/real-step2.png' });
    console.log('Step 2 screenshot saved!');

    const step2Html = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal');
      return {
        text: modal ? modal.textContent : '',
        buttons: Array.from(modal ? modal.querySelectorAll('button') : []).map(b => ({
          text: b.innerText.trim(),
          aria: b.getAttribute('aria-label'),
          class: b.className
        }))
      };
    });
    console.log('Step 2 details:', JSON.stringify(step2Html, null, 2));

  } finally {
    await ctx.close();
  }
})().catch(e => console.error(e));
