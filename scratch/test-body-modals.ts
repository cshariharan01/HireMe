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

  const bodyModals = await page.evaluate(() => {
    const all = Array.from(document.body.querySelectorAll('*'));
    const matches = all.filter(el => {
      const role = el.getAttribute('role');
      const ariaModal = el.getAttribute('aria-modal');
      const cls = el.className || '';
      return role === 'dialog' || ariaModal === 'true' || (typeof cls === 'string' && cls.includes('modal'));
    });
    return matches.map(m => ({
      tag: m.tagName,
      role: m.getAttribute('role'),
      ariaModal: m.getAttribute('aria-modal'),
      cls: m.className,
      textPreview: (m.textContent || '').slice(0, 80).replace(/\s+/g, ' '),
      hasButtons: Array.from(m.querySelectorAll('button')).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean)
    }));
  });

  console.log('Body modal candidates:', JSON.stringify(bodyModals, null, 2));

  await ctx.close();
})();
