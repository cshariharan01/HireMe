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

  // Find the container holding the text "تقدم إلى" or "WhiteLotus"
  const modalInfo = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(e =>
      e.children.length > 2 && (e.textContent?.includes('تقدم إلى') || e.textContent?.includes('WhiteLotus'))
    );
    if (!el) return null;
    let curr: HTMLElement | null = el as HTMLElement;
    const path: any[] = [];
    while (curr && curr !== document.body) {
      path.push({
        tag: curr.tagName,
        id: curr.id,
        className: curr.className,
        role: curr.getAttribute('role'),
        ariaModal: curr.getAttribute('aria-modal'),
      });
      curr = curr.parentElement;
    }
    return path;
  });
  console.log('Modal hierarchy:', JSON.stringify(modalInfo, null, 2));

  await ctx.close();
})();
