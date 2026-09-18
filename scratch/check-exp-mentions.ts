import db from '../src/lib/db';

const jobs = db.prepare('SELECT id, title, description FROM job_postings WHERE id IN (18053, 18066, 18082, 17917, 17668, 18090, 18054, 18060)').all();

for (const j of jobs) {
  console.log(`\n=== JOB ${j.id}: ${j.title} ===`);
  const matches = (j.description || '').match(/.{0,40}(?:years?|yrs?|yoe|experience|exp).{0,40}/gi) || [];
  console.log(matches.slice(0, 5));
}
