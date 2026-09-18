const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ extraHTTPHeaders: { 'Accept-Language': 'ar' } });
  await p.goto('https://www.linkedin.com/jobs/view/4465714034/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  const links = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.innerText?.trim(),
      href: a.href,
      class: a.className,
      dataTrack: a.getAttribute('data-tracking-control-name'),
    })).filter(a => a.href && (a.href.includes('login') || a.href.includes('signup') || a.href.includes('join') || a.href.includes('auth')));
  });
  console.log('Login/Signup links in Arabic:\n', JSON.stringify(links, null, 2));
  await b.close();
})();
