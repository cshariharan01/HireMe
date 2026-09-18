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
  await page.waitForTimeout(3000);

  const res = await page.evaluate(async () => {
    const csrfMatch = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    // First try GET to see exact schema/structure
    const getRes = await fetch('https://www.linkedin.com/mysettings-api/settingsApiSettings/interfaceLocale', {
      headers: {
        'csrf-token': csrf,
        'X-RestLi-Protocol-Version': '2.0.0',
        'Accept': 'application/json'
      }
    });
    const getBody = await getRes.json().catch(e => ({ error: e.message }));

    // Now send PUT to set it to en_US
    const putRes = await fetch('https://www.linkedin.com/mysettings-api/settingsApiSettings/interfaceLocale', {
      method: 'PUT',
      headers: {
        'csrf-token': csrf,
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        value: 'en_US',
        settingType: 'INTERFACE_LOCALE'
      })
    });

    let putBody = null;
    try {
      putBody = await putRes.text();
    } catch (e) {
      putBody = e.message;
    }

    return {
      csrfFound: !!csrf,
      getStatus: getRes.status,
      getBody,
      putStatus: putRes.status,
      putBody
    };
  });

  console.log('API RESULT:', JSON.stringify(res, null, 2));

  // Also set cookie
  await page.evaluate(() => {
    document.cookie = 'lang="v=2&lang=en-us"; Domain=.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
    document.cookie = 'lang="v=2&lang=en-us"; Domain=www.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
    document.cookie = 'UserLocale=en_US; Domain=.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
    document.cookie = 'UserLocale=en_US; Domain=www.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
  });

  // Reload settings page to verify
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const verify = await page.evaluate(() => {
    const s = document.querySelector('select');
    return {
      selectValue: s ? s.value : null,
      selectedOption: s && s.selectedOptions[0] ? s.selectedOptions[0].text : null,
      htmlLang: document.documentElement.getAttribute('lang'),
      htmlDir: document.documentElement.getAttribute('dir'),
    };
  });
  console.log('VERIFY AFTER PUT:', JSON.stringify(verify, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
