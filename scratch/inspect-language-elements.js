const { chromium } = require('playwright');
const path = require('path');
const { execSync } = require('child_process');

const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  try {
    const ps = `$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*browser-profile*' }; foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }`;
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`);
  } catch {}

  await new Promise(r => setTimeout(r, 1000));

  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('Navigating to language preferences...');
  await page.goto('https://www.linkedin.com/mypreferences/d/settings/language', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Take screenshot for debugging
  await page.screenshot({ path: 'scratch/language-settings.png' });

  const elements = await page.evaluate(() => {
    // Only inspect leaf or small elements with text
    const all = Array.from(document.querySelectorAll('*'));
    return all
      .filter(el => {
        const text = (el.innerText || '').trim();
        return text.includes('English') && text.length < 50;
      })
      .map(el => ({
        tag: el.tagName,
        id: el.id,
        className: el.className,
        role: el.getAttribute('role'),
        text: el.innerText.trim(),
        html: el.outerHTML.slice(0, 150)
      }));
  });

  console.log('Matching English elements:', JSON.stringify(elements, null, 2));

  // Also check all inputs / radios on the page
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, [role="radio"]')).map(el => ({
      tag: el.tagName,
      type: el.getAttribute('type'),
      id: el.id,
      name: el.getAttribute('name'),
      checked: el.checked || el.getAttribute('aria-checked'),
      value: el.value,
      ariaLabel: el.getAttribute('aria-label'),
      parentText: (el.parentElement ? el.parentElement.innerText : '').slice(0, 50)
    }));
  });

  console.log('All inputs/radios on page:', JSON.stringify(inputs, null, 2));

  await ctx.close();
})().catch(e => console.error('Error:', e));
