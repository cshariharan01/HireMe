const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  
  await page.screenshot({ path: 'scratch/settings-language.png' });

  const info = await page.evaluate(async () => {
    // Check cookies
    const cookies = document.cookie;
    
    // Check interfaceLocale via API
    let apiLocale = null;
    try {
      const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1];
      const res = await fetch('https://www.linkedin.com/mysettings-api/settingsApiSettings/interfaceLocale', {
        headers: { 'csrf-token': csrf }
      });
      apiLocale = await res.json();
    } catch (e) {
      apiLocale = e.message;
    }

    return {
      title: document.title,
      htmlLang: document.documentElement.getAttribute('lang'),
      htmlDir: document.documentElement.getAttribute('dir'),
      cookiesSnippet: cookies.slice(0, 300),
      apiLocale,
      textSnippet: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500)
    };
  });
  console.log('LANGUAGE SETTINGS INFO:', JSON.stringify(info, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
