import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Take a screenshot and also dump all buttons on page
  const buttons = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return all.map(el => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: (el.innerText || '').trim().replace(/\s+/g, ' '),
      aria: el.getAttribute('aria-label') || '',
      className: el.className,
      id: el.id,
      visible: (el as HTMLElement).offsetParent !== null,
    })).filter(b => b.text || b.aria);
  });

  console.log('Total interactive elements:', buttons.length);
  // Filter only those in main/job area
  const mainButtons = buttons.filter(b => b.visible && b.text.length < 50);
  console.log('Short visible buttons/links:');
  console.log(JSON.stringify(mainButtons, null, 2));

  // Check language and html lang
  const htmlLang = await page.getAttribute('html', 'lang');
  console.log('html lang:', htmlLang);

  await ctx.close();
})();
