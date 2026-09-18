import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

const urls = [
  'https://www.linkedin.com/jobs/view/4417311866/',
  'https://www.linkedin.com/jobs/view/4454972268/',
  'https://www.linkedin.com/jobs/view/4465722265/'
];

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  for (const url of urls) {
    console.log('\n--- Checking URL:', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('Final URL:', page.url());
    console.log('Title:', await page.title());

    const topCardText = await page.evaluate(() => {
      const top = document.querySelector('.top-card-layout, .jobs-unified-top-card, .job-details-jobs-unified-top-card, .topcard, header');
      return top ? top.innerText : document.body.innerText.slice(0, 1000);
    });
    console.log('Top card snippet:\n', topCardText.slice(0, 400));

    // Check if there is any apply button or if it says "No longer accepting applications"
    const statusInfo = await page.evaluate(() => {
      const body = document.body.innerText;
      const closed = /no longer accepting applications|closed|لم يعد يقبل طلبات/i.test(body);
      const applyButtons = Array.from(document.querySelectorAll('button, a'))
        .filter(el => {
          const txt = (el.innerText || el.getAttribute('aria-label') || '').trim();
          return /apply|easy|تقدم|قدم/i.test(txt);
        })
        .map(el => ({
          tag: el.tagName,
          text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\n+/g, ' '),
          classes: el.className,
          href: el.getAttribute('href'),
          visible: (el as HTMLElement).offsetParent !== null
        }));
      return { closed, applyButtons };
    });
    console.log('Status info:', JSON.stringify(statusInfo, null, 2));
  }

  await ctx.close();
})();
