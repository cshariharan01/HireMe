const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

try {
  console.log('--- Columns of my_applications ---');
  console.log(db.prepare("PRAGMA table_info(my_applications)").all().map(c => c.name));

  console.log('--- Columns of apply_audit ---');
  console.log(db.prepare("PRAGMA table_info(apply_audit)").all().map(c => c.name));

  console.log('--- Columns of resumes ---');
  console.log(db.prepare("PRAGMA table_info(resumes)").all().map(c => c.name));

  console.log('--- Columns of job_documents ---');
  console.log(db.prepare("PRAGMA table_info(job_documents)").all().map(c => c.name));

  console.log('\n--- my_applications for job 1000056 ---');
  console.log(db.prepare("SELECT * FROM my_applications WHERE job_id = 1000056").all());

  console.log('\n--- apply_audit for job 1000056 ---');
  console.log(db.prepare("SELECT * FROM apply_audit WHERE job_id = 1000056").all());

  console.log('\n--- job_documents for job 1000056 ---');
  console.log(db.prepare("SELECT * FROM job_documents WHERE job_id = 1000056").all());

  console.log('\n--- All resumes in db ---');
  console.log(db.prepare("SELECT id, name, target_role, is_default, created_at FROM resumes").all());

} catch (err) {
  console.error(err);
}
