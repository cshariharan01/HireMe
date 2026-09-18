// Deep probe Hirist - extract a real card to confirm structure.
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-IN',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  await page.goto('https://www.hirist.tech/k/fhir-jobs', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(5000);

  // Sample one card to see the structure
  const sample = await page.evaluate(() => {
    const containers = Array.from(document.querySelectorAll('.MuiPaper-root, .MuiCardContent-root, [class*="joblist"]'));
    // Return first 3 distinct containers' outer HTML, truncated
    const out: string[] = [];
    for (const c of containers) {
      const html = (c as HTMLElement).outerHTML.slice(0, 1500);
      if (out.length < 3 && html.length > 200) out.push(html);
    }
    return out;
  });
  for (let i = 0; i < sample.length; i++) {
    console.log(`\n=== sample ${i} ===\n` + sample[i]);
  }

  // Also try to find job links pattern
  const jobLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    return links
      .filter((a) => /\/j\/|\/job\//i.test(a.href || ''))
      .slice(0, 5)
      .map((a) => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 80) }));
  });
  console.log('\njob links:', jobLinks);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
