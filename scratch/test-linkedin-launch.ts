import path from 'path';
import { launchApplyBrowser } from '../src/lib/apply/launcher';

(async () => {
  const profileDir = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  console.log('Testing launchApplyBrowser...');
  try {
    const ctx = await launchApplyBrowser(profileDir);
    console.log('Successfully launched browser!');
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://www.linkedin.com/jobs/view/4417311866/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Landed on URL:', page.url());
    console.log('Page title:', await page.title());
    await page.waitForTimeout(4000);
    
    // Check buttons
    const buttons = await page.$$eval('button, a', els =>
      els.map(e => ({
        tag: e.tagName,
        text: (e.innerText || '').trim(),
        class: e.className,
        aria: e.getAttribute('aria-label') || '',
        visible: (e as HTMLElement).offsetParent !== null
      })).filter(e => /apply|easy|تقدم|قدم/i.test(e.text + ' ' + e.aria))
    );
    console.log('Apply buttons found:', JSON.stringify(buttons, null, 2));

    await ctx.close();
    console.log('Browser closed cleanly.');
  } catch (err) {
    console.error('Test failed with error:', err);
  }
})();
