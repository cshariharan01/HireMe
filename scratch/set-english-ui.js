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

  const selection = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"], [role="radio"]')).map(r => ({
      id: r.id,
      name: r.name,
      value: r.value,
      checked: r.checked || r.getAttribute('aria-checked') === 'true',
      label: document.querySelector(`label[for="${r.id}"]`)?.textContent?.trim() || r.parentElement?.textContent?.trim()
    }));
    return { radios };
  });

  console.log('RADIOS ON LANGUAGE PAGE:', JSON.stringify(selection, null, 2));

  // Find the English radio option and click it
  console.log('Looking for English radio option...');
  const englishRadio = page.locator('label:has-text("English"), [value*="en_US"], [value*="en-US"], input[id*="en"]').first();
  if ((await englishRadio.count()) > 0) {
    console.log('Clicking English option...');
    await englishRadio.click();
    await page.waitForTimeout(3000);
  } else {
    console.log('No English radio selector matched directly, trying click by text');
    const label = page.locator('text=English').first();
    await label.click();
    await page.waitForTimeout(3000);
  }

  // Check if there is a save button or if it saved automatically
  const saveBtn = page.locator('button:has-text("Save"), button:has-text("حفظ")').first();
  if ((await saveBtn.count()) > 0 && (await saveBtn.isVisible())) {
    console.log('Clicking save button...');
    await saveBtn.click();
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: 'scratch/after-click-english.png' });
  console.log('Saved after-click-english.png');

  await ctx.close();
})().catch(e => console.error(e));
