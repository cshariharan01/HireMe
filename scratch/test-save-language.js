const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  page.on('request', req => {
    if (req.url().includes('settingsApiSettings/interfaceLocale')) {
      console.log('PUT Request Headers:', JSON.stringify(req.headers(), null, 2));
      console.log('PUT Request Body:', req.postData());
    }
  });

  page.on('response', async resp => {
    if (resp.url().includes('settingsApiSettings/interfaceLocale')) {
      console.log('PUT Response Status:', resp.status());
      try {
        console.log('PUT Response Body:', await resp.text());
      } catch {}
    }
  });

  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  console.log('Selecting option via Playwright selectOption...');
  // In Ember / LinkedIn settings, the select element has onchange.
  // Let's trigger change event properly.
  await page.locator('select').selectOption('en_US');
  await page.locator('select').dispatchEvent('change');

  console.log('Waiting 8 seconds for PUT response...');
  await page.waitForTimeout(8000);

  // Reload page to verify if setting persisted
  console.log('Reloading settings page to verify persistence...');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const finalVal = await page.evaluate(() => {
    const sel = document.querySelector('select');
    return {
      value: sel ? sel.value : null,
      text: sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : null
    };
  });
  console.log('Final verified dropdown setting:', finalVal);

  await page.screenshot({ path: 'scratch/settings-after-reload.png' });

  await ctx.close();
})().catch(e => console.error(e));
