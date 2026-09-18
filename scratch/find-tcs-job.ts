import db from '../src/lib/db';
import { extractPostingFacts } from '../src/lib/posting-facts';

const jobs = db.prepare("SELECT id, title, company, description, url FROM job_postings WHERE company LIKE '%Tata%' AND title LIKE '%GCP Data%'").all();

for (const j of jobs as any[]) {
  console.log(`\n=== Job ${j.id}: ${j.title} (${j.company}) ===`);
  console.log('URL:', j.url);
  const facts = extractPostingFacts(j.description || '', '', j.title || '', j.url || '');
  console.log('Facts:', facts);
  console.log('Desc excerpt:', (j.description || '').slice(0, 500));
}
