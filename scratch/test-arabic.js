const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ extraHTTPHeaders: { 'Accept-Language': 'ar' } });
  await p.goto('https://www.linkedin.com/jobs/view/4465714034/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4000);
  console.log('HTML lang:', await p.evaluate(() => document.documentElement.getAttribute('lang')));
  console.log('hasGlobalNav:', await p.evaluate(() => !!document.querySelector('#global-nav, .global-nav, nav.global-nav, nav[aria-label="Primary"]')));
  const authState = await p.evaluate(() => {
    return {
      hasGlobalNav: !!document.querySelector('#global-nav, .global-nav, nav.global-nav, nav[aria-label="Primary"]'),
      hasMeIcon: !!document.querySelector('.global-nav__me, img[alt*="Photo"], button[aria-label*="Me"]'),
      bodyHasSignInText: /تسجيل الدخول|انضم الآن|sign in|join now/i.test(document.body.innerText),
      anchorsWithLogin: Array.from(document.querySelectorAll('a[href*="login"], a[href*="checkpoint"], a[href*="cold-join"], button')).map(e => ({
        tag: e.tagName,
        text: (e.innerText || '').trim(),
        href: e.getAttribute('href'),
        className: e.className,
      })).slice(0, 10),
    };
  });
  console.log('Auth state:', JSON.stringify(authState, null, 2));
  await b.close();
})();
