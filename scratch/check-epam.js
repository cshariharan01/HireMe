const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

try {
  console.log('--- EPAM jobs ---');
  const jobs = db.prepare("SELECT id, company, title, source, url FROM job_postings WHERE company LIKE '%epam%' OR title LIKE '%epam%'").all();
  console.log(jobs);

  console.log('\n--- Recent jobs in job_postings (last 10) ---');
  const recentJobs = db.prepare("SELECT id, company, title, source, url FROM job_postings ORDER BY id DESC LIMIT 10").all();
  console.log(recentJobs);

  console.log('\n--- Recent apply_audit (last 10) ---');
  const audits = db.prepare("SELECT id, job_id, strategy, status, error, attempted_at, payload_snapshot FROM apply_audit ORDER BY id DESC LIMIT 10").all();
  for (const a of audits) {
    console.log(`\nAudit #${a.id} job_id=${a.job_id} strategy=${a.strategy} status=${a.status} attempted_at=${a.attempted_at} error=${a.error}`);
    try {
      const snap = JSON.parse(a.payload_snapshot);
      console.log('response:', JSON.stringify(snap.response));
    } catch {
      console.log('payload:', a.payload_snapshot?.slice(0, 200));
    }
  }

} catch (err) {
  console.error(err);
}
