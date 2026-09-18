import db from '../src/lib/db';

const jobs = db.prepare("SELECT id, title, company, description FROM job_postings WHERE description LIKE '%exp%5+%' OR description LIKE '%experience%5+%' OR description LIKE '%5+%years%' OR description LIKE '%5+ years%'").all();

console.log(`Found ${jobs.length} jobs with 5+ experience patterns:`);
for (const j of jobs as any[]) {
  const matches = (j.description || '').match(/.{0,30}(?:exp|experience).{0,30}/gi) || [];
  console.log(`Job ${j.id}: "${j.title}" (${j.company})`);
  console.log('  ', matches.slice(0, 3));
}
