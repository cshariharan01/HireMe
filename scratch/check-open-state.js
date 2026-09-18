const http = require('http');
const puppeteer = require('puppeteer-core');

http.get('http://127.0.0.1:9222/json/version', async (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', async () => {
    try {
      const v = JSON.parse(data);
      console.log('Browser:', v.Browser);
      const browser = await puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl });
      const pages = await browser.pages();
      console.log('Pages count:', pages.length);
      const page = pages.find(p => p.url().includes('linkedin.com')) || pages[0];
      if (page) {
        console.log('Page URL:', page.url());
        const info = await page.evaluate(() => {
          const dialog = document.querySelector('dialog');
          const submitBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Submit application'));
          return {
            htmlLang: document.documentElement.lang,
            htmlDir: document.documentElement.dir,
            dialogOpen: dialog ? dialog.open : false,
            dialogText: dialog ? dialog.innerText.slice(0, 300) : '',
            submitVisible: !!submitBtn,
            submitText: submitBtn ? submitBtn.innerText : null
          };
        });
        console.log('Info:', info);
        await page.screenshot({ path: 'scratch/final-review-en.png' });
        console.log('Screenshot saved to scratch/final-review-en.png');
      }
      browser.disconnect();
    } catch (e) {
      console.error(e);
    }
  });
}).on('error', (e) => {
  console.log('CDP connection error:', e.message);
});
