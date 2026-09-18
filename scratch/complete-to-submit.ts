import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  console.log('Launching browser...');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    const jobUrl = 'https://www.linkedin.com/jobs/view/4440422331/?locale=en_US';
    console.log('Navigating to job:', jobUrl);
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 1. Click Easy Apply
    console.log('Clicking Easy Apply...');
    await page.locator('button:has-text("Easy Apply")').first().click();
    await page.waitForTimeout(2500);

    // Step 1: Fill Phone
    console.log('Step 1: Contact info - filling mobile phone...');
    // Find the input on step 1:
    const step1Input = page.locator('.jobs-easy-apply-modal input[type="text"], .jobs-easy-apply-modal input[type="tel"], .jobs-easy-apply-modal input:not([type])').first();
    await step1Input.fill('6383827363');
    console.log('Filled phone: 6383827363');

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'scratch/proof-step1-filled.png' });

    // Click Next
    console.log('Clicking Next on Step 1...');
    await page.locator('.jobs-easy-apply-modal button:has-text("Next")').first().click();
    await page.waitForTimeout(3000);

    // Step 2: Resume
    console.log('Step 2: Resume screen');
    await page.screenshot({ path: 'scratch/proof-step2.png' });

    console.log('Clicking Next on Step 2...');
    await page.locator('.jobs-easy-apply-modal button:has-text("Next")').first().click();
    await page.waitForTimeout(3000);

    // Step 3: Questions
    console.log('Step 3: Questions screen');
    // Radio Yes: "Do you have 6+ years of hands on experience in Data Engineering*"
    const yesOpt = page.locator('.jobs-easy-apply-modal label:has-text("Yes")').first();
    if (await yesOpt.isVisible()) {
      await yesOpt.click();
      console.log('Selected Yes for Data Engineering experience');
    }

    // Fill numeric inputs: Distributed Data Processing & PySpark
    const textInps = page.locator('.jobs-easy-apply-modal input[type="text"], .jobs-easy-apply-modal input:not([type])');
    const cnt = await textInps.count();
    for (let i = 0; i < cnt; i++) {
      if (await textInps.nth(i).isVisible()) {
        await textInps.nth(i).fill('3');
        console.log(`Filled question input ${i} with 3`);
      }
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'scratch/proof-step3-filled.png' });

    // Click Review
    console.log('Clicking Review button on Step 3...');
    await page.locator('.jobs-easy-apply-modal button:has-text("Review")').first().click();
    await page.waitForTimeout(4000);

    // Step 4: Final Review / Submit application!
    console.log('--- Step 4: Final Review & Submit Screen ---');
    await page.screenshot({ path: 'scratch/proof-final-submit-en.png' });

    const reviewState = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
      const submitBtn = Array.from(modal?.querySelectorAll('button') || []).find(b => /submit/i.test(b.innerText || b.getAttribute('aria-label') || ''));
      return {
        title: document.title,
        htmlLang: document.documentElement.getAttribute('lang'),
        htmlDir: document.documentElement.getAttribute('dir'),
        header: modal?.querySelector('h3, h2, h4')?.textContent?.trim(),
        submitButtonFound: !!submitBtn,
        submitButtonText: submitBtn?.textContent?.trim(),
        allButtons: Array.from(modal?.querySelectorAll('button') || []).map(b => b.innerText.trim()).filter(Boolean)
      };
    });

    console.log('FINAL REVIEW STATE:', JSON.stringify(reviewState, null, 2));

  } finally {
    await ctx.close();
    console.log('Done!');
  }
})().catch(e => console.error('Error during proof run:', e));
