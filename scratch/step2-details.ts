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
    console.log('On Step 1. Filling phone...');
    const phoneInput = page.locator('input[id*="phoneNumber"], input[name*="phoneNumber"], input[type="tel"]').first();
    if (await phoneInput.isVisible()) {
      await phoneInput.fill('6383827363');
      console.log('Filled phone 6383827363');
    }

    const nextBtn1 = page.locator('button:has-text("Next")').first();
    console.log('Clicking Next on Step 1...');
    await nextBtn1.click();
    await page.waitForTimeout(3000);

    // Now on Step 2!
    console.log('--- Step 2 State ---');
    await page.screenshot({ path: 'scratch/actual-step2.png' });
    console.log('Saved scratch/actual-step2.png');

    const step2Info = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal') || document.querySelector('[role="dialog"]');
      if (!modal) return { modal: false };
      return {
        modal: true,
        header: modal.querySelector('h3, h2')?.textContent?.trim(),
        text: modal.textContent?.slice(0, 500),
        inputs: Array.from(modal.querySelectorAll('input, select, textarea')).map(el => ({
          tag: el.tagName,
          type: (el as HTMLInputElement).type,
          id: el.id,
          name: (el as HTMLInputElement).name,
          value: (el as HTMLInputElement).value
        })),
        buttons: Array.from(modal.querySelectorAll('button')).map(b => ({
          text: b.innerText.trim(),
          aria: b.getAttribute('aria-label'),
          class: b.className,
          disabled: (b as HTMLButtonElement).disabled
        }))
      };
    });

    console.log('Step 2 Info:', JSON.stringify(step2Info, null, 2));

  } finally {
    await ctx.close();
  }
})().catch(e => console.error('Error:', e));
