import db from '../src/lib/db';

const jobs = db.prepare('SELECT id, title, description FROM job_postings WHERE id IN (18054, 18060)').all();

for (const j of jobs) {
  console.log(`\n=== Job ${j.id}: ${j.title} ===`);
  console.log(j.description);
}
