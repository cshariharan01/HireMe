const cheerio = require('cheerio');
async function test() {
  const url = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Data%20Engineer&location=India&f_AL=true&sortBy=DD&start=0';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    }
  });
  console.log('Status:', res.status);
  const html = await res.text();
  const $ = cheerio.load(html);
  $('li').slice(0, 3).each((i, el) => {
    const $el = $(el);
    const title = $el.find('h3.base-search-card__title').text().trim();
    const company = $el.find('h4.base-search-card__subtitle').text().trim();
    const loc = $el.find('.job-search-card__location').text().trim();
    const date = $el.find('time').attr('datetime');
    const href = $el.find('a.base-card__full-link').attr('href');
    console.log({ title, company, loc, date, href: href?.slice(0, 60) });
  });
}
test();
