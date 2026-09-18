import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    console.log('Navigating to job 4440422331 in English...');
    await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // 1. Click Easy Apply
    console.log('Clicking Easy Apply...');
    await page.locator('button:has-text("Easy Apply")').first().click();
    await page.waitForSelector('.jobs-easy-apply-modal', { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Step 1: Contact Info
    console.log('--- Step 1: Contact Info ---');
    const phoneInput = page.locator('input[id*="phoneNumber"], input[name*="phoneNumber"], input[type="tel"]').first();
    if (await phoneInput.isVisible()) {
      await phoneInput.fill('6383827363');
      console.log('Filled phone: 6383827363');
    }
    await page.screenshot({ path: 'scratch/step1-en.png' });

    // Click Next to Step 2
    console.log('Advancing to Step 2...');
    await page.locator('.jobs-easy-apply-modal footer button:has-text("Next")').click();
    await page.waitForTimeout(3000);

    // Step 2: Resume
    console.log('--- Step 2: Resume Selection ---');
    await page.screenshot({ path: 'scratch/step2-en.png' });
    // Click Next to Step 3
    console.log('Advancing to Step 3...');
    await page.locator('.jobs-easy-apply-modal footer button:has-text("Next")').click();
    await page.waitForTimeout(3000);

    // Step 3: Additional Questions
    console.log('--- Step 3: Questions ---');
    await page.screenshot({ path: 'scratch/step3-en.png' });

    // Answer Question 1: "Do you have 6+ years of hands on experience..." -> Click Yes
    console.log('Answering Question 1 (Yes radio)...');
    const yesLabel = page.locator('.jobs-easy-apply-modal label:has-text("Yes")').first();
    if (await yesLabel.isVisible()) {
      await yesLabel.click();
    }

    // Answer Questions 2 & 3: Distributed Data Processing & PySpark -> Fill "3"
    console.log('Answering numeric questions with 3 years...');
    const textInputs = page.locator('.jobs-easy-apply-modal input[type="text"], .jobs-easy-apply-modal input:not([type])');
    const inputCount = await textInputs.count();
    for (let i = 0; i < inputCount; i++) {
      const inp = textInputs.nth(i);
      if (await inp.isVisible()) {
        await inp.fill('3');
      }
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'scratch/step3-filled-en.png' });

    // Click "Review" button in footer
    console.log('Clicking Review button...');
    const reviewBtn = page.locator('.jobs-easy-apply-modal footer button:has-text("Review")');
    await reviewBtn.click();
    await page.waitForTimeout(4000);

    // Step 4: Final Review Step!
    console.log('--- Step 4: Final Review & Submit Screen ---');
    await page.screenshot({ path: 'scratch/step4-review-submit-en.png' });

    const reviewDetails = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal');
      const submitBtn = modal ? Array.from(modal.querySelectorAll('button')).find(b => /submit/i.test(b.innerText || b.getAttribute('aria-label') || '')) : null;
      return {
        htmlLang: document.documentElement.getAttribute('lang'),
        htmlDir: document.documentElement.getAttribute('dir'),
        header: modal ? modal.querySelector('h3, h2, h4')?.textContent?.trim() : null,
        submitButtonFound: !!submitBtn,
        submitButtonText: submitBtn ? submitBtn.innerText.trim() : null,
        modalTextSnippet: modal ? modal.textContent?.replace(/\s+/g, ' ').slice(0, 500) : null
      };
    });

    console.log('Final Review Details:', JSON.stringify(reviewDetails, null, 2));

  } finally {
    await ctx.close();
  }
})().catch(e => console.error('Error in flow:', e));
