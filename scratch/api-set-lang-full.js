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

    const payload = {
      settingDisplayType: "DROPDOWN",
      entityUrn: "urn:li:settingEntity:400007",
      hasChild: false,
      key: "interfaceLocale",
      value: "en_US"
    };

    const putRes = await fetch('https://www.linkedin.com/mysettings-api/settingsApiSettings/interfaceLocale', {
      method: 'PUT',
      headers: {
        'csrf-token': csrf,
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    return {
      putStatus: putRes.status,
      putBody: await putRes.text()
    };
  });

  console.log('PUT RESULT:', JSON.stringify(res, null, 2));

  // Purge any old cookies and set en-US
  await page.evaluate(() => {
    document.cookie = 'lang="v=2&lang=en-us"; Domain=.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
    document.cookie = 'lang="v=2&lang=en-us"; Domain=www.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
    document.cookie = 'UserLocale=en_US; Domain=.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
    document.cookie = 'UserLocale=en_US; Domain=www.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
  });

  // Verify by reloading
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const verify = await page.evaluate(async () => {
    const csrfMatch = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    const getRes = await fetch('https://www.linkedin.com/mysettings-api/settingsApiSettings/interfaceLocale', {
      headers: {
        'csrf-token': csrf,
        'X-RestLi-Protocol-Version': '2.0.0',
        'Accept': 'application/json'
      }
    });
    const data = await getRes.json();
    return {
      activeValue: data.value,
      selectValue: document.querySelector('select')?.value,
      selectedText: document.querySelector('select')?.selectedOptions[0]?.text
    };
  });

  console.log('PERSISTED SETTING VERIFICATION:', JSON.stringify(verify, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
