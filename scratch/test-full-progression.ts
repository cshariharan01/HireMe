import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    console.log('Navigating to job 4440422331...');
    await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const applyBtn = page.locator('button:has-text("Easy Apply"), button[aria-label*="Easy Apply"]').first();
    await applyBtn.click();
    await page.waitForTimeout(2000);

    // Step 1: Contact info
    console.log('Step 1: Contact Info');
    const phoneInput = page.locator('input[id*="phoneNumber"], input[name*="phoneNumber"], input[type="tel"]').first();
    if (await phoneInput.isVisible()) {
      await phoneInput.fill('6383827363');
    }
    await page.locator('button:has-text("Next")').first().click();
    await page.waitForTimeout(2500);

    // Step 2: Resume selection
    console.log('Step 2: Resume');
    await page.screenshot({ path: 'scratch/flow-step2.png' });
    
    // Scroll modal and click Next
    const nextBtn2 = page.locator('.jobs-easy-apply-modal footer button:has-text("Next"), button:has-text("Next")').first();
    await nextBtn2.scrollIntoViewIfNeeded().catch(() => {});
    await nextBtn2.click();
    await page.waitForTimeout(2500);

    // Step 3: Questions / Additional info
    console.log('Step 3: Additional Info / Questions');
    await page.screenshot({ path: 'scratch/flow-step3.png' });

    const step3Info = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal') || document.querySelector('[role="dialog"]');
      if (!modal) return { text: 'no modal' };
      return {
        progress: modal.querySelector('[aria-valuenow], [aria-label*="page" i], .fb-form-header')?.textContent?.trim(),
        text: modal.textContent?.slice(0, 400),
        buttons: Array.from(modal.querySelectorAll('footer button, button')).map(b => b.innerText.trim()).filter(Boolean)
      };
    });
    console.log('Step 3 Info:', JSON.stringify(step3Info, null, 2));

    // Fill questions or click Review / Next
    const reviewOrNext = page.locator('button:has-text("Review"), button:has-text("Next")').first();
    if (await reviewOrNext.isVisible()) {
      console.log('Clicking Review / Next on Step 3...');
      await reviewOrNext.click();
      await page.waitForTimeout(2500);
    }

    // Step 4: Final Review step!
    console.log('Step 4: Final Review');
    await page.screenshot({ path: 'scratch/flow-step4-review.png' });

    const step4Info = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal') || document.querySelector('[role="dialog"]');
      return {
        title: document.title,
        lang: document.documentElement.getAttribute('lang'),
        dir: document.documentElement.getAttribute('dir'),
        modalText: modal?.textContent?.slice(0, 400),
        buttons: Array.from(modal?.querySelectorAll('button') || []).map(b => b.innerText.trim()).filter(Boolean)
      };
    });
    console.log('Step 4 Info:', JSON.stringify(step4Info, null, 2));

  } finally {
    await ctx.close();
  }
})().catch(e => console.error('Error:', e));
