import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const applyBtn = page.locator('.jobs-apply-button, button:has-text("Easy Apply")').first();
    await applyBtn.click();
    await page.waitForTimeout(2000);

    // Step 1: Contact info
    console.log('--- Step 1 ---');
    const dialog = page.locator('dialog, [role="dialog"]').first();
    const phoneInput = dialog.locator('input[type="tel"], input[id*="phone" i], input[type="text"]').first();
    await phoneInput.fill('6383827363');
    console.log('Filled phone: 6383827363');
    await page.screenshot({ path: 'scratch/proof-step1-filled.png' });

    // Click Next
    console.log('Clicking Next on Step 1...');
    await dialog.locator('footer button:has-text("Next"), button:has-text("Next")').first().click();
    await page.waitForTimeout(3000);

    // Step 2: Resume
    console.log('--- Step 2 (Resume) ---');
    await page.screenshot({ path: 'scratch/proof-step2.png' });
    console.log('Clicking Next on Step 2...');
    await dialog.locator('footer button:has-text("Next"), button:has-text("Next")').first().click();
    await page.waitForTimeout(3000);

    // Step 3: Questions
    console.log('--- Step 3 (Questions) ---');
    const yesRadio = dialog.locator('label:has-text("Yes"), input[value="Yes"]').first();
    if (await yesRadio.isVisible()) {
      await yesRadio.click();
      console.log('Clicked Yes for experience question');
    }

    const textInputs = dialog.locator('input[type="text"], input:not([type])');
    const count = await textInputs.count();
    for (let i = 0; i < count; i++) {
      const inp = textInputs.nth(i);
      if (await inp.isVisible()) {
        await inp.fill('3');
        console.log(`Filled question input ${i} with 3`);
      }
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'scratch/proof-step3-filled.png' });

    // Click Review
    console.log('Clicking Review...');
    await dialog.locator('footer button:has-text("Review"), button:has-text("Review")').first().click();
    await page.waitForTimeout(3000);

    // Step 4: Final Review / Submit!
    console.log('--- Step 4 (Final Review / Submit) ---');
    await page.screenshot({ path: 'scratch/proof-final-review.png' });

    const reviewState = await page.evaluate(() => {
      const modal = document.querySelector('dialog, [role="dialog"]');
      const submitBtn = Array.from(modal?.querySelectorAll('button') || []).find(b => /submit/i.test(b.innerText || b.getAttribute('aria-label') || ''));
      return {
        title: document.title,
        htmlLang: document.documentElement.getAttribute('lang'),
        htmlDir: document.documentElement.getAttribute('dir'),
        header: modal?.querySelector('h3, h2, h4')?.textContent?.trim(),
        modalTextSnippet: modal?.textContent?.replace(/\s+/g, ' ').slice(0, 400),
        submitButtonFound: !!submitBtn,
        submitButtonText: submitBtn?.textContent?.trim(),
        allButtons: Array.from(modal?.querySelectorAll('button') || []).map(b => b.innerText.trim()).filter(Boolean)
      };
    });

    console.log('Final Review State in English:', JSON.stringify(reviewState, null, 2));

  } finally {
    await ctx.close();
    console.log('Done!');
  }
})().catch(e => console.error(e));
