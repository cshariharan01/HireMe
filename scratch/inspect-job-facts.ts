import db from '../src/lib/db';
import { extractPostingFacts } from '../src/lib/posting-facts';

const jobs = db.prepare('SELECT id, title, company, description, url FROM job_postings WHERE id IN (18053, 18066, 18082, 17917, 17668, 18090, 18054, 18060)').all();

for (const j of jobs) {
  console.log(`\n=== JOB ${j.id}: ${j.title} (${j.company}) ===`);
  const facts = extractPostingFacts(j.description || '', j.url || '');
  console.log('Extracted facts:', facts);
  const descExcerpt = (j.description || '').slice(0, 500).replace(/\n+/g, ' ');
  console.log('Desc excerpt:', descExcerpt);
}
