import { launchApplyBrowser } from '../src/lib/apply/launcher';
import { handleNaukriChatbot } from '../src/lib/apply/naukri';
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
    if ((await applyBtn.count()) > 0) {
      console.log('Clicking Apply button...');
      await applyBtn.click();
      await page.waitForTimeout(3000);
    }

    const profile = {
      name: 'Hariharan Subramaniyan',
      email: 'cshariharan2001@gmail.com',
      phone: '6383827363',
      location: 'Madurai, India',
      yearsOfExperience: 3,
      currentCompany: 'Solartis Technology',
      noticePeriodDays: 30,
      currentCtcInr: 700000,
      expectedCtcInr: 1200000,
    };

    console.log('Running handleNaukriChatbot...');
    const result = await handleNaukriChatbot({
      page,
      profile,
      companyName: 'Epam Systems',
      jobTitle: 'Snowflake Data Engineer',
      resumeFilename: 'Hariharan_Subramaniyan_Data_Engineer_Resume.pdf',
      resumePdfBytes: new Uint8Array([1, 2, 3]),
      maxSteps: 15,
    });

    console.log('Result from handleNaukriChatbot:', JSON.stringify(result, null, 2));

    await page.screenshot({ path: 'scratch/epam-pune-result.png' });
    console.log('Screenshot saved to scratch/epam-pune-result.png');

    await ctx.close();
  } catch (err) {
    console.error('Error running EPAM Pune apply:', err);
  }
})();
