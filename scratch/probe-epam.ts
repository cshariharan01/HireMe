import { launchApplyBrowser } from '../src/lib/apply/launcher';
import path from 'path';

const BROWSER_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
const EPAM_URL = 'https://www.naukri.com/job-listings-hiring-alert-epam-systems-senior-snowflake-data-engineer-epam-systems-chennai-coimbatore-bengaluru-3-to-8-years-080926028462';

(async () => {
  try {
    const ctx = await launchApplyBrowser(BROWSER_PROFILE_DIR, { focus: false });
    const page = ctx.pages()[0] || (await ctx.newPage());
    console.log('Navigating to EPAM job...');
    await page.goto(EPAM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const applyBtn = page.locator('button#apply-button, button.apply-button, button:has-text("Apply")').first();
    const count = await applyBtn.count();
    console.log('Apply button count:', count);
    if (count > 0) {
      console.log('Apply button text:', await applyBtn.innerText());
      if ((await applyBtn.innerText()).toLowerCase().includes('applied')) {
        console.log('Already applied!');
      } else {
        await applyBtn.click();
        await page.waitForTimeout(3000);
      }
    }

    const drawerOpen = (await page.locator('div.chatbot_DrawerContentWrapper, div[class*="chatbot"]').count()) > 0;
    console.log('Drawer open:', drawerOpen);

    const botMessages = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('li.botItem, div.botItem, div.botMsg, div.msg_container.bot'));
      return els.map(e => e.textContent?.trim()).filter(Boolean);
    });
    console.log('Bot messages:', botMessages);

    const inputs = await page.evaluate(() => {
      return {
        contenteditable: Array.from(document.querySelectorAll('[contenteditable="true"]')).map(e => ({ class: e.className, tag: e.tagName })),
        inputs: Array.from(document.querySelectorAll('input')).map(e => ({ type: e.type, class: e.className, name: e.name, id: e.id })),
        labels: Array.from(document.querySelectorAll('label')).map(e => ({ class: e.className, text: e.textContent?.trim() })),
        buttons: Array.from(document.querySelectorAll('button, div.send, div.sendMsg')).map(e => ({ class: e.className, text: e.textContent?.trim() })),
      };
    });
    console.log('Inputs found:', JSON.stringify(inputs, null, 2));

    await page.screenshot({ path: 'scratch/epam-screenshot.png' });
    console.log('Screenshot saved to scratch/epam-screenshot.png');

    await ctx.close();
  } catch (err) {
    console.error('Error probing EPAM:', err);
  }
})();
