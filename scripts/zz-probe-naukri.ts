import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-IN',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const url = 'https://www.naukri.com/fhir-architect-jobs';
  console.log('Getting', url);
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('status:', resp?.status());
  await page.waitForTimeout(6000);
  console.log('final url:', page.url());
  const info = await page.evaluate(() => {
    const all = document.querySelectorAll('[class*="jobTuple"],[class*="job-tuple"],[class*="srp"],[class*="noResult"],[class*="no-result"],[class*="title"]');
    const counts: Record<string, number> = {};
    for (const el of all) {
      const c = String(el.className || '');
      if (!c) continue;
      const key = c.split(' ').slice(0, 2).join(' ');
      counts[key] = (counts[key] || 0) + 1;
    }
    return {
      bodyLen: document.body.innerText.length,
      bodyHead: document.body.innerText.slice(0, 300).replace(/\s+/g, ' '),
      hasTile: !!document.querySelector('[class*="job-tuple"],[class*="jobTuple"],[data-jobtitle]'),
      hasNoResult: /no jobs found|no result|we couldn|second .* come|something went wrong/i.test(document.body.innerText.slice(0, 1500)),
      classSample: Object.entries(counts).slice(0, 30),
      anchors: Array.from(document.querySelectorAll('a[href*="minj1"]')).length,
      totalAnchors: document.querySelectorAll('a[href*="naukri.com/job"]').length,
      firstCardHtml: (() => {
        const c = document.querySelector('[class*="job-tuple"],[class*="jobTuple"],[class*="srp-jobtuple"]');
        return c ? c.outerHTML.slice(0, 800) : null;
      })(),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });