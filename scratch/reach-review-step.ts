import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    await page.locator('button:has-text("Easy Apply")').first().click();
    await page.waitForTimeout(2000);

    const phone = page.locator('input[id*="phoneNumber"], input[name*="phoneNumber"], input[type="tel"]').first();
    if (await phone.isVisible()) await phone.fill('6383827363');
    await page.locator('button:has-text("Next")').first().click();
    await page.waitForTimeout(2000);

    await page.locator('.jobs-easy-apply-modal footer button:has-text("Next"), button:has-text("Next")').first().click();
    await page.waitForTimeout(2500);

    // On Step 3: inspect questions DOM
    const qDetails = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal');
      const fieldsets = Array.from(modal?.querySelectorAll('fieldset') || []);
      const inputs = Array.from(modal?.querySelectorAll('input') || []);
      return {
        fieldsets: fieldsets.map(f => ({
          legend: f.querySelector('legend')?.textContent?.trim(),
          radios: Array.from(f.querySelectorAll('input[type="radio"], label')).map(r => ({
            tag: r.tagName,
            text: r.textContent?.trim(),
            id: r.id,
            checked: (r as HTMLInputElement).checked
          }))
        })),
        textInputs: inputs.filter(i => i.type !== 'radio').map(i => ({
          id: i.id,
          name: i.name,
          label: (i.id ? document.querySelector(`label[for="${i.id}"]`)?.textContent : '')?.trim()
        }))
      };
    });

    console.log('Step 3 Questions Structure:', JSON.stringify(qDetails, null, 2));

    // Try answering them:
    // 1. Click Yes on radio
    const yesRadio = page.locator('label:has-text("Yes"), input[value="Yes"]').first();
    if (await yesRadio.isVisible()) {
      await yesRadio.click();
      console.log('Clicked Yes radio');
    }

    // 2. Fill numeric experience inputs
    const numInputs = page.locator('.jobs-easy-apply-modal input[type="text"], .jobs-easy-apply-modal input:not([type])');
    const count = await numInputs.count();
    for (let i = 0; i < count; i++) {
      const inp = numInputs.nth(i);
      if (await inp.isVisible()) {
        await inp.fill('3');
        console.log(`Filled input ${i} with 3`);
      }
    }

    await page.waitForTimeout(1000);

    // Click Review
    const reviewBtn = page.locator('.jobs-easy-apply-modal footer button:has-text("Review"), button:has-text("Review")').first();
    console.log('Clicking Review button...');
    await reviewBtn.click();
    await page.waitForTimeout(3000);

    // Step 4 screenshot!
    console.log('--- Step 4 (Final Review / Submit) ---');
    await page.screenshot({ path: 'scratch/actual-review-screen.png' });
    console.log('Saved scratch/actual-review-screen.png!');

    const reviewState = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal');
      const submitBtn = document.querySelector('button[aria-label*="Submit" i], footer button:has-text("Submit"), button:has-text("Submit application")');
      return {
        title: document.title,
        lang: document.documentElement.getAttribute('lang'),
        dir: document.documentElement.getAttribute('dir'),
        header: modal?.querySelector('h3, h2, h4')?.textContent?.trim(),
        modalSnippet: modal?.textContent?.slice(0, 400),
        submitButtonFound: !!submitBtn,
        submitButtonText: submitBtn?.textContent?.trim(),
        buttons: Array.from(modal?.querySelectorAll('button') || []).map(b => b.innerText.trim()).filter(Boolean)
      };
    });

    console.log('Review State:', JSON.stringify(reviewState, null, 2));

  } finally {
    await ctx.close();
  }
})().catch(e => console.error(e));
