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
  console.log('Button found:', await applyBtn.count());
  await applyBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  console.log('Clicking button...');
  await applyBtn.click({ force: true });
  console.log('Clicked! Waiting 5s...');
  await page.waitForTimeout(5000);

  console.log('Current URL:', page.url());
  const screenshotPath = path.join(process.cwd(), 'scratch', 'after-click.png');
  await page.screenshot({ path: screenshotPath });
  console.log('Saved screenshot to:', screenshotPath);

  // Check modals or new elements
  const modals = await page.$$eval('[role="dialog"], [aria-modal="true"], .jobs-easy-apply-modal, .artdeco-modal', els =>
    els.map(e => ({
      classes: e.className,
      text: e.innerText ? e.innerText.slice(0, 100).replace(/\s+/g, ' ') : '',
      role: e.getAttribute('role'),
      ariaLabel: e.getAttribute('aria-label')
    }))
  );
  console.log('Modals on page:', JSON.stringify(modals, null, 2));

  await ctx.close();
})();
