import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: 'scratch/before-click-apply.png' });

    const applyBtns = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      return btns.filter(b => /apply|easy|تقدم|قدم/i.test(b.innerText || b.getAttribute('aria-label') || ''))
        .map(b => ({
          tag: b.tagName,
          text: b.innerText.trim(),
          aria: b.getAttribute('aria-label'),
          class: b.className,
          visible: (b as HTMLElement).offsetParent !== null
        }));
    });
    console.log('Apply buttons detected:', JSON.stringify(applyBtns, null, 2));

    // Try clicking using the primary apply selector
    const btn = page.locator('.jobs-apply-button, button:has-text("Easy Apply"), button[aria-label*="Easy Apply" i]').first();
    console.log('Clicking apply button...');
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(3000);

    await page.screenshot({ path: 'scratch/after-click-apply.png' });
    console.log('Saved scratch/after-click-apply.png');

    const modalCheck = await page.evaluate(() => {
      const m = document.querySelector('dialog, [role="dialog"], .jobs-easy-apply-modal');
      return {
        hasModal: !!m,
        tag: m?.tagName,
        class: m?.className,
        textSnippet: m?.textContent?.slice(0, 200)
      };
    });
    console.log('Modal check:', JSON.stringify(modalCheck, null, 2));

  } finally {
    await ctx.close();
  }
})().catch(e => console.error(e));
