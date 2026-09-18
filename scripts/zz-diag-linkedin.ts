// Throwaway diagnostic: open LinkedIn job page(s) in the REAL logged-in profile and dump the
// apply-control DOM (tag/class/text/href) plus what our two detectors return. Read-only.
import { chromium, type Page, type BrowserContext } from 'playwright';
import path from 'path';
import {
  detectLinkedInEasyApply,
  detectLinkedInExternalApply,
  detectLinkedInLoginRequired,
  revealApplyForm,
  hasFillableApplicationForm,
} from '../src/lib/apply/linkedin';

const PROFILE = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
const CLEAN_SELECTORS =
  'button.jobs-apply-button, a.jobs-apply-button, [class*="jobs-apply-button"], ' +
  'a[data-tracking-control-name*="offsite"], a[data-tracking-control-name*="external"], ' +
  '[data-test="apply-button"], [data-job-apply-external], a[data-tracking-control-name*="in_jobs_apply_cta"]';

async function dump(page: Page, ctx: BrowserContext): Promise<void> {
  console.log('--- url:', page.url());
  if (await detectLinkedInLoginRequired(page).catch(() => false)) console.log('--- login required!');
  const external = await detectLinkedInExternalApply(page).catch((e) => {
    console.log('external detect ERR', e.message);
    return null;
  });
  console.log('--- detectLinkedInEasyApply:', await detectLinkedInEasyApply(page).catch((e) => 'ERR ' + e.message));
  console.log('--- detectLinkedInExternalApply:', external);
  if (external) {
    console.log('--- waking external site:', external.slice(0, 120));
    try {
      const popups: Array<import('playwright').Page> = [];
      const onP = (p: import('playwright').Page) => {
        popups.push(p);
        console.log('--- POPUP opened:', String(p.url()).slice(0, 160));
        p.on('load', () => console.log('--- popup loaded:', String(p.url()).slice(0, 160)));
        p.on('framenavigated', (f) => {
          if (f === p.mainFrame()) console.log('--- popup navigated:', String(f.url()).slice(0, 160));
        });
      };
      ctx.on('page', onP);
      await page.goto(external, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(4000);
      const formPage = await revealApplyForm(page, ctx);
      await formPage.waitForTimeout(1500);
      console.log('--- external landed:', formPage.url().slice(0, 160));
      const sels = await formPage.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter((el) => {
          const t = ((el.textContent || '') + ' ' + ((el as HTMLElement).getAttribute?.('aria-label') || ''));
          return /apply/i.test(t);
        });
        return els.slice(0, 8).map((el) => ({
          tag: el.tagName,
          cls: (el as HTMLElement).className ? String((el as HTMLElement).className).slice(0, 50) : null,
          href: (el as HTMLAnchorElement).href || null,
          text: ((el.textContent || '').trim()).slice(0, 40),
          aria: (el as HTMLElement).getAttribute?.('aria-label'),
        }));
      });
      console.log('--- apply-ish elements:', JSON.stringify(sels, null, 2));
      const deepWait = await formPage.waitForTimeout(9000);
      const after = await formPage.evaluate(() => ({
        url: location.href,
        hasPwd: !!document.querySelector('input[type="password"]'),
        forms: document.querySelectorAll('form').length,
        inputs: Array.from(document.querySelectorAll('input, textarea, select')).filter((i) => (i as HTMLInputElement).offsetParent !== null).map((i) => (i as HTMLInputElement).name || (i as HTMLInputElement).id || i.tagName).slice(0, 12),
      }));
      console.log('--- after 9s settle:', JSON.stringify(after));
      for (const p of popups) {
        try {
          const pUrl = p.url();
          const hasPwd = await p.evaluate(() => !!document.querySelector('input[type="password"]'));
          const fillableP = await hasFillableApplicationForm(p);
          console.log('--- popup check:', pUrl.slice(0, 120), '| password?', hasPwd, '| fillable?', fillableP);
        } catch (e) {
          console.log('--- popup check ERR:', (e as Error).message);
        }
      }
      const has = await hasFillableApplicationForm(formPage);
      console.log('--- form fields present after reveal:', has);
      const extra = await formPage.evaluate(() => {
        const url = location.href;
        const txt = (document.body.innerText || '').slice(0, 3000);
        const pwd = document.querySelector('input[type="password"]');
        return {
          url,
          looksLogin: /login|signin|sso|idp|authorize|account|okta|microsoftonline/i.test(url),
          hasPassword: !!pwd,
          redirTrack: !!document.querySelector('meta[http-equiv="refresh"]'),
        };
      });
      console.log('--- classifier probe:', JSON.stringify(extra));
      console.log('--- body snippet:', JSON.stringify((await formPage.evaluate(() => document.body.innerText.slice(0, 400))).replace(/\s+/g, ' ').slice(0, 400)));
      const fields = await formPage.evaluate(() => {
        const out: Array<Record<string, string | null>> = [];
        for (const el of Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 20)) {
          const e = el as HTMLInputElement;
          out.push({
            name: e.name || null,
            id: e.id || null,
            type: e.type || el.tagName.toLowerCase(),
            label: e.getAttribute('aria-label'),
            'data-qa': e.getAttribute('data-qa'),
            'data-testid': e.getAttribute('data-testid'),
            ph: e.getAttribute('placeholder'),
            accept: e.accept || null,
            value: (e as HTMLInputElement).value ? String((e as HTMLInputElement).value).slice(0, 30) : null,
          });
        }
        return out;
      });
      console.log('--- field sample:', JSON.stringify(fields, null, 2));
    } catch (e) {
      console.log('--- external walk failed:', (e as Error).message);
    }
  } else {
    console.log('--- (no external link — Easy Apply job)');
  }
}

(async () => {
  const urls = process.argv.slice(2).filter((u) => u.startsWith('http'));
  if (urls.length === 0) {
    console.error('Usage: npx ts-node scripts/zz-diag-linkedin.ts <job-url> [more-urls...]');
    process.exit(1);
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(5000);
        await dump(page, ctx);
      } catch (e) {
        console.log('--- goto failed for', url, ':', (e as Error).message);
      }
      await page.waitForTimeout(1500);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});