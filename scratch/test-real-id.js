const cheerio = require('cheerio');
async function test() {
  const searchUrl = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Data%20Engineer&location=India&f_AL=true&sortBy=DD&start=0';
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    }
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  const ids = [];
  $('[data-entity-urn]').each((_, el) => {
    const urn = $(el).attr('data-entity-urn') || '';
    const m = urn.match(/jobPosting:(\d+)/);
    if (m) ids.push(m[1]);
  });
  console.log('Got IDs:', ids.slice(0, 5));
  if (ids.length > 0) {
    const id = ids[0];
    const t0 = Date.now();
    const detailUrl = `https://www.linkedin.com/jobs/view/${id}/`;
    console.log('Fetching', detailUrl);
    const dRes = await fetch(detailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });
    console.log('Detail status:', dRes.status, 'Time:', Date.now() - t0, 'ms');
  }
}
test();
