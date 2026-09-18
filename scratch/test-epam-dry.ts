import { launchApplyBrowser } from '../src/lib/apply/launcher';
import path from 'path';

const BROWSER_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
const EPAM_PUNE_URL = 'https://www.naukri.com/job-listings-snowflake-data-engineer-epam-systems-pune-3-to-8-years-030926016605';

(async () => {
  try {
    const ctx = await launchApplyBrowser(BROWSER_PROFILE_DIR, { focus: false });
    const page = ctx.pages()[0] || (await ctx.newPage());
    console.log('Navigating to EPAM Pune job...');
    await page.goto(EPAM_PUNE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const applyBtn = page.locator('button#apply-button, button.apply-button, button:has-text("Apply")').first();
    const count = await applyBtn.count();
    console.log('Apply button count:', count);
    if (count > 0) {
      const btnText = await applyBtn.innerText();
      console.log('Apply button text:', btnText);
    }
    await ctx.close();
  } catch (err) {
    console.error('Error probing EPAM Pune:', err);
  }
})();
