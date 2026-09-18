import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  await applyBtn.click({ force: true });
  await page.waitForTimeout(2000);

  const modal = page.locator('dialog, [role="dialog"][aria-modal="true"]').first();
  const phone = modal.locator('input[type="tel"]').first();
  if (await phone.count() > 0) {
    await phone.fill('6383827363');
  }

  const nextBtn = modal.locator('footer button').filter({ hasText: /التالي|Next|المتابعة/ }).first();
  await nextBtn.click();
  await page.waitForTimeout(3000);

  // Scroll down inside modal
  await modal.evaluate((m) => {
    m.scrollTop = m.scrollHeight;
    const scrollers = m.querySelectorAll('*');
    for (const s of scrollers) {
      if (s.scrollHeight > s.clientHeight) {
        s.scrollTop = s.scrollHeight;
      }
    }
  });
  await page.waitForTimeout(1000);

  // Take screenshot
  await page.screenshot({ path: path.join(process.cwd(), 'scratch', 'step2-scrolled-down.png') });

  // Dump buttons/inputs inside modal
  const elements = await modal.evaluate((m) => {
    const items = Array.from(m.querySelectorAll('button, input, label'));
    return items.map(el => ({
      tag: el.tagName,
      type: (el as HTMLInputElement).type,
      text: el.textContent?.trim().slice(0, 50).replace(/\s+/g, ' '),
      aria: el.getAttribute('aria-label'),
      id: el.id,
      name: (el as HTMLInputElement).name,
      accept: (el as HTMLInputElement).accept,
    })).filter(x => x.text || x.aria || x.type === 'file');
  });

  console.log('Step 2 scrolled elements:', JSON.stringify(elements, null, 2));

  await ctx.close();
})();
