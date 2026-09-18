const { chromium } = require('playwright');
const path = require('path');
const profileDir = path.resolve('data/playwright/browser-profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });

  console.log('--- Before clear ---');
  const b = await ctx.cookies();
  console.log(b.filter(c => c.name === 'lang'));

  console.log('\nCalling ctx.clearCookies({ name: "lang" })...');
  await ctx.clearCookies({ name: 'lang' });

  console.log('\n--- After clear ---');
  const a = await ctx.cookies();
  console.log(a.filter(c => c.name === 'lang'));

  console.log('\nNow calling CDP Network.deleteCookies...');
  const page = ctx.pages()[0] || await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.deleteCookies', { name: 'lang', domain: '.linkedin.com' });
  await cdp.send('Network.deleteCookies', { name: 'lang', domain: 'www.linkedin.com' });
  await cdp.send('Network.deleteCookies', { name: 'lang', domain: '.www.linkedin.com' });
  await cdp.send('Network.deleteCookies', { name: 'lang', domain: 'linkedin.com' });

  console.log('\n--- After CDP deleteCookies ---');
  const afterCdp = await ctx.cookies();
  console.log(afterCdp.filter(c => c.name === 'lang'));

  await ctx.close();
})().catch(e => console.error(e));
