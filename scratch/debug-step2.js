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
  await page.waitForTimeout(3000);
  await page.locator('.jobs-apply-button, button:has-text("Easy Apply")').first().click();
  await page.waitForTimeout(2000);

  const d = page.locator('dialog, [role="dialog"]').first();
  await d.locator('input[type="tel"], input[type="text"]').first().fill('6383827363');
  
  // Click Next on Step 1
  console.log('Clicking Next on Step 1...');
  await d.locator('footer button:has-text("Next"), button:has-text("Next")').first().click();
  await page.waitForTimeout(2500);

  // Now inspect Step 2 in full detail
  console.log('Reached Step 2! Inspecting...');
  const step2Info = await page.evaluate(() => {
    const dialog = document.querySelector('dialog, [role="dialog"]');
    if (!dialog) return { error: 'No dialog found' };

    const buttons = Array.from(dialog.querySelectorAll('button')).map(b => ({
      text: b.innerText.trim(),
      ariaLabel: b.getAttribute('aria-label'),
      disabled: b.disabled,
      classes: b.className,
      visible: b.offsetParent !== null,
      parent: b.parentElement ? b.parentElement.tagName + '.' + b.parentElement.className : null
    }));

    const fileInputs = Array.from(dialog.querySelectorAll('input[type="file"]')).map(inp => ({
      id: inp.id,
      name: inp.name,
      accept: inp.accept
    }));

    const allInputs = Array.from(dialog.querySelectorAll('input, select, textarea')).map(i => ({
      tag: i.tagName,
      type: i.type,
      id: i.id,
      value: i.value
    }));

    return {
      title: document.title,
      htmlLang: document.documentElement.getAttribute('lang'),
      htmlDir: document.documentElement.getAttribute('dir'),
      header: dialog.querySelector('h3, h2, h4')?.textContent?.trim(),
      buttons,
      fileInputs,
      allInputs,
      textSnippet: dialog.innerText.slice(0, 500)
    };
  });

  console.log('STEP 2 DETAILED INFO:', JSON.stringify(step2Info, null, 2));

  await ctx.close();
})().catch(e => console.error(e));
