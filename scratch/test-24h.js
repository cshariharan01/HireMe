const cheerio = require('cheerio');
async function test() {
  const url = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Data%20Engineer&location=India&f_AL=true&sortBy=DD&f_TPR=r86400&start=0';
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    }
  });
  console.log('Status:', res.status, 'Time:', Date.now() - t0, 'ms');
  const html = await res.text();
  const $ = cheerio.load(html);
  let count = 0;
  $('li').each((i, el) => {
    const title = $(el).find('h3.base-search-card__title').text().trim();
    const date = $(el).find('time').attr('datetime') || $(el).find('time').text().trim();
    if (title) {
      count++;
      if (count <= 5) console.log(`  [${count}] ${title} — posted: ${date}`);
    }
  });
  console.log('Total 24h jobs found on page 1:', count);
}
test();
