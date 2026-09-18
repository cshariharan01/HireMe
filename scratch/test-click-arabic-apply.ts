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
  await applyBtn.click();
  console.log('Clicked Easy Apply button!');
  await page.waitForTimeout(3000);

  // Check dialog buttons
  const buttons = await page.locator('[role="dialog"] button, div[aria-modal="true"] button').evaluateAll(btns =>
    btns.map(b => ({
      text: (b.innerText || '').trim().replace(/\s+/g, ' '),
      aria: b.getAttribute('aria-label') || '',
      classes: b.className
    }))
  );
  console.log('Dialog buttons count:', buttons.length);
  console.log('Dialog buttons:', JSON.stringify(buttons, null, 2));

  // Check dialog inputs
  const inputs = await page.locator('[role="dialog"] input, [role="dialog"] select, [role="dialog"] textarea').evaluateAll(els =>
    els.map(e => ({
      tag: e.tagName,
      type: (e as HTMLInputElement).type,
      name: (e as HTMLInputElement).name,
      id: e.id,
      value: (e as HTMLInputElement).value
    }))
  );
  console.log('Dialog inputs:', JSON.stringify(inputs, null, 2));

  await ctx.close();
})();
