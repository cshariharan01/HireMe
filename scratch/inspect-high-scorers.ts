import db from '../src/lib/db';

async function test() {
  const highApps = db.prepare(`
    SELECT a.id, a.job_id, j.company, j.title, a.default_score, a.tailored_score,
           a.resume_tex IS NOT NULL as has_tex,
           a.resume_variant IS NOT NULL as has_var
    FROM my_applications a
    JOIN job_postings j ON a.job_id = j.id
    WHERE a.tailored_score > 70
    ORDER BY a.tailored_score DESC
    LIMIT 5
  `).all() as any[];

  console.log('High scoring applications:');
  console.log(JSON.stringify(highApps, null, 2));

  for (const app of highApps) {
    const job = db.prepare('SELECT title, description FROM job_postings WHERE id = ?').get(app.job_id) as any;
    console.log(`\n=== [${app.job_id}] ${app.company} - ${app.title} (Score: ${app.tailored_score}, Default: ${app.default_score}) ===`);
    console.log('JD length:', job.description?.length);
    console.log('JD excerpt:', job.description?.slice(0, 300));
  }
}

test().catch(console.error);
