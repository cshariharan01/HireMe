import { chromium } from 'playwright';

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const contexts = browser.contexts();
    const page = contexts[0]?.pages().find(p => p.url().includes('linkedin.com'));
    if (page) {
      console.log('Connected to LinkedIn page:', page.url());
      await page.screenshot({ path: 'scratch/clean-step4-proof.png' });
      console.log('Saved screenshot to scratch/clean-step4-proof.png');
      const dialogInfo = await page.evaluate(() => {
        const dialog = document.querySelector('dialog');
        const submitBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Submit application'));
        return {
          lang: document.documentElement.lang,
          dir: document.documentElement.dir,
          dialogTitle: dialog ? dialog.querySelector('h2, h3, h1')?.innerText : null,
          submitBtnFound: !!submitBtn,
          submitText: submitBtn?.innerText
        };
      });
      console.log('Dialog Info:', dialogInfo);
    }
  } catch (err) {
    console.log('CDP check note:', err.message);
  }
})();
