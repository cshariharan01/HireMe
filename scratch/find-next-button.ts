import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  await applyBtn.click({ force: true });
  await page.waitForTimeout(3000);

  // Find button with text "التالي"
  const nextInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.find(b => (b.innerText || '').includes('التالي'));
    if (!target) return 'NO BUTTON WITH التالي FOUND';
    const parents: any[] = [];
    let curr: HTMLElement | null = target;
    while (curr && curr !== document.body) {
      parents.push({
        tag: curr.tagName,
        cls: curr.className,
        role: curr.getAttribute('role'),
        ariaModal: curr.getAttribute('aria-modal'),
        id: curr.id
      });
      curr = curr.parentElement;
    }
    return parents;
  });

  console.log('Next button parents:', JSON.stringify(nextInfo, null, 2));

  await ctx.close();
})();
