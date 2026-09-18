import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  const ctx = await launchApplyBrowser(profileDir);
  const page = ctx.pages()[0] || (await ctx.newPage());

  const url = 'https://www.linkedin.com/jobs/view/4465722265/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const applyBtn = page.locator('button:has-text("التقديم السريع"), button:has-text("Easy Apply"), button[aria-label*="التقديم"], button[aria-label*="Easy Apply" i]').first();
  await applyBtn.click({ force: true });
  await page.waitForTimeout(3000);

  // Inspect the phone field and its label
  const phoneInfo = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    return inputs.map(inp => {
      const id = inp.id;
      const label = id ? document.querySelector(`label[for="${id}"]`) : inp.closest('label');
      return {
        id: inp.id,
        type: inp.type,
        name: inp.name,
        value: inp.value,
        labelText: label ? label.textContent?.trim() : '',
        placeholder: inp.placeholder,
        ariaLabel: inp.getAttribute('aria-label')
      };
    }).filter(i => /phone|mobile|هاتف|email|البريد/i.test(i.labelText + ' ' + (i.ariaLabel || '') + ' ' + (i.placeholder || '')));
  });

  console.log('Phone/Email fields found:', JSON.stringify(phoneInfo, null, 2));

  // Try filling phone via getByLabel or label heuristic
  const phoneInput = page.locator('[role="dialog"]').getByLabel(/phone|mobile|هاتف/i).first();
  console.log('getByLabel count:', await phoneInput.count());
  if (await phoneInput.count() > 0) {
    await phoneInput.fill('9876543210');
    console.log('Filled phone successfully!');
  } else {
    // Try fallback
    const fallback = page.locator('[role="dialog"] input[type="text"]').first();
    console.log('Fallback count:', await fallback.count());
  }

  // Click Next button ("التالي" or "Next")
  const nextBtn = page.locator('[role="dialog"] button:has-text("التالي"), [role="dialog"] button:has-text("Next"), button:has-text("التالي")').first();
  console.log('Next button count:', await nextBtn.count());
  if (await nextBtn.count() > 0) {
    console.log('Next button text:', await nextBtn.innerText());
    await nextBtn.click();
    console.log('Clicked Next button! Waiting 3s...');
    await page.waitForTimeout(3000);
    const screenshotPath = path.join(process.cwd(), 'scratch', 'step2.png');
    await page.screenshot({ path: screenshotPath });
    console.log('Saved step 2 screenshot to:', screenshotPath);
  }

  await ctx.close();
})();
