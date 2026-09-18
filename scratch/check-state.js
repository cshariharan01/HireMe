const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.linkedin.com/jobs/view/4440422331/?locale=en_US', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  
  await page.screenshot({ path: 'scratch/current-page-state.png' });

  const info = await page.evaluate(() => {
    return {
      title: document.title,
      url: window.location.href,
      htmlLang: document.documentElement.getAttribute('lang'),
      htmlDir: document.documentElement.getAttribute('dir'),
      buttons: Array.from(document.querySelectorAll('button, a.jobs-apply-button')).map(b => b.innerText?.trim()).filter(Boolean).slice(0, 30),
      bodyTextSnippet: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600)
    };
  });
  console.log('PAGE STATE:', JSON.stringify(info, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
