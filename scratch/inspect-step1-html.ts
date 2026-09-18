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
    await page.waitForTimeout(2500);

    const step1Inputs = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
      if (!modal) return { found: false };
      return {
        found: true,
        inputs: Array.from(modal.querySelectorAll('input, select, textarea')).map(i => ({
          tag: i.tagName,
          type: (i as HTMLInputElement).type,
          id: i.id,
          name: (i as HTMLInputElement).name,
          value: (i as HTMLInputElement).value,
          label: i.id ? document.querySelector(`label[for="${i.id}"]`)?.textContent?.trim() : null
        })),
        buttons: Array.from(modal.querySelectorAll('button')).map(b => ({
          text: b.innerText.trim(),
          aria: b.getAttribute('aria-label'),
          class: b.className
        }))
      };
    });

    console.log('Step 1 HTML Details:', JSON.stringify(step1Inputs, null, 2));
  } finally {
    await ctx.close();
  }
})().catch(e => console.error(e));
