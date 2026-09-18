import { launchApplyBrowser } from '../src/lib/apply/launcher';
import path from 'path';

const BROWSER_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
const EPAM_64_URL = 'https://www.naukri.com/job-listings-snowflake-data-engineer-epam-systems-bengaluru-3-to-8-years-070926004855';

(async () => {
  try {
    const ctx = await launchApplyBrowser(BROWSER_PROFILE_DIR, { focus: false });
    const page = ctx.pages()[0] || (await ctx.newPage());
    console.log('Navigating to EPAM 1000064...');
    await page.goto(EPAM_64_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const applyBtn = page.locator('button#apply-button, button.apply-button, button:has-text("Apply")').first();
    const count = await applyBtn.count();
    console.log('Apply button count:', count);
    if (count > 0) {
      const btnText = await applyBtn.innerText();
      console.log('Apply button text:', btnText);
      if (!btnText.toLowerCase().includes('applied')) {
        await applyBtn.click();
        await page.waitForTimeout(2500);

        // Check drawer
        const drawer = page.locator('div.chatbot_DrawerContentWrapper, div[class*="chatbot"]').first();
        console.log('Drawer visible:', await drawer.isVisible());

        // Read messages
        const msgs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('li.botItem, div.botItem, div.botMsg')).map(e => e.textContent?.trim()).filter(Boolean);
        });
        console.log('Bot messages:', msgs);

        // Check interactive elements
        const radios = await drawer.locator('label.ssrc__label, .singleselect-radiobutton').count();
        const checkboxes = await drawer.locator('div.multiselectcheckboxes, .mcc__checkbox, label.mcc__label').count();
        const textInputs = await drawer.locator('div[contenteditable="true"].textArea, div.textArea, [contenteditable="true"]').count();
        const sends = await drawer.locator('div.send, button:has-text("Save")').count();

        console.log('Radios in drawer:', radios);
        console.log('Checkboxes in drawer:', checkboxes);
        console.log('Text inputs in drawer:', textInputs);
        console.log('Send/Save buttons in drawer:', sends);
      }
    }
    await ctx.close();
  } catch (err) {
    console.error(err);
  }
})();
