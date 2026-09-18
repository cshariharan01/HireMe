// Definitive lang diagnostic with the NEW real-Chrome launcher:
// 1. What login state does the profile carry right now?
// 2. What language does LinkedIn serve, and does the CORRECT cookie value flip it?
import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

const PROFILE = process.argv[2] || path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
const JOB = process.argv[3] || 'https://www.linkedin.com/jobs/view/4463576100/';

async function state(page: import('playwright').Page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body.innerText || '').slice(0, 1500);
      return {
        url: location.href.split('?')[0],
        htmlLang: document.documentElement.getAttribute('lang'),
        rtl: !!document.querySelector('html[dir="rtl"]'),
        arabicChars: (text.match(/[\u0600-\u06FF]/g) || []).length,
        authwall: location.href.includes('authwall'),
        loginFields: !!document.querySelector('input[name="session_key"], input#username'),
      };
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

(async () => {
  const ctx = await launchApplyBrowser(PROFILE);
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(JOB, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(5000);
    console.log('1 PLAIN GOTO   =>', JSON.stringify(await state(page)));

    // Correct LinkedIn cookie format, exact value the on-page switcher writes.
    await ctx.addCookies([
      { name: 'lang', value: 'v=2&lang=en-us', domain: '.linkedin.com', path: '/' },
      { name: 'lang', value: 'v=2&lang=en-us', domain: '.www.linkedin.com', path: '/' },
    ]);
    await page.goto(JOB, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(5000);
    console.log('2 AFTER COOKIE =>', JSON.stringify(await state(page)));

    // If still not English, try clicking LinkedIn's own on-page language item.
    const switched = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('a,button,[role="menuitem"],[role="button"],li'))
        .map((e) => e as HTMLElement)
        .filter((e) => {
          const t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
          return /^English( \(English\))?\s*$/.test(t) || t.startsWith('English (English)');
        });
      const el = cands[0];
      if (el) {
        el.click();
        return { clicked: true, text: (el.innerText || '').slice(0, 30) };
      }
      return { clicked: false };
    });
    console.log('3 SWITCHER CLICK =>', JSON.stringify(switched));
    await page.waitForTimeout(6000);
    console.log('4 AFTER SWITCH  =>', JSON.stringify(await state(page)));

    const cookies = await ctx.cookies('https://www.linkedin.com');
    console.log('5 COOKIES:', cookies.filter((c) => /lang/i.test(c.name)).map((c) => `${c.name}="${String(c.value).slice(0, 30)}"`).join(' | ') || '(none)');
  } finally {
    await ctx.close().catch(() => {});
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});