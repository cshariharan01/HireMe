const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  await ctx.addCookies([
    { name: 'li_at', value: 'AQEDAUwTNE4Cn7ZWAAABoJwMZakAAAGgwBjpqU4ATYGaHB2Tbdh49AskZvPr4HRTsEY7w0Fyp23W-ETZJnzHFHAtOZd81WC5yPAqZrOclRC_YDQIzYmYPifvQdwec48pLlSsKU_ae0Gs7B0u3vFUmCIH', domain: '.www.linkedin.com', path: '/' },
    { name: 'li_at', value: 'AQEDAUwTNE4Cn7ZWAAABoJwMZakAAAGgwBjpqU4ATYGaHB2Tbdh49AskZvPr4HRTsEY7w0Fyp23W-ETZJnzHFHAtOZd81WC5yPAqZrOclRC_YDQIzYmYPifvQdwec48pLlSsKU_ae0Gs7B0u3vFUmCIH', domain: '.linkedin.com', path: '/' },
  ]);
  const page = await ctx.newPage();
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language');
  await page.waitForTimeout(4000);

  const items = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, label, li, [role="radio"]'));
    return inputs.map(r => ({
      tag: r.tagName,
      role: r.getAttribute('role'),
      text: (r.innerText || r.getAttribute('aria-label') || '').slice(0, 40).trim(),
      id: r.id,
      checked: r.checked || r.getAttribute('aria-checked'),
      value: r.value
    })).filter(x => x.text.includes('English') || x.text.includes('العربية') || x.checked);
  });
  console.log('Language DOM items:', JSON.stringify(items, null, 2));

  // Now try clicking English
  const clicked = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label, [role="radio"], button, li'));
    const englishEl = labels.find(l => {
      const t = (l.innerText || l.getAttribute('aria-label') || '').trim();
      return t.includes('English');
    });
    if (englishEl) {
      englishEl.click();
      return true;
    }
    return false;
  });
  console.log('Clicked English:', clicked);
  await page.waitForTimeout(4000);
  console.log('After click URL:', page.url());
  console.log('After click title:', await page.title());
  console.log('HTML lang:', await page.evaluate(() => document.documentElement.getAttribute('lang')));
  console.log('Dir:', await page.evaluate(() => document.documentElement.getAttribute('dir')));

  await browser.close();
})();
