const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

const prof = db.prepare('SELECT resume_tex FROM my_profile').get();
const doc = db.prepare('SELECT resume_tex, cover_letter FROM job_documents WHERE job_id = 17827').get();
const job = db.prepare('SELECT id, title, company, description FROM job_postings WHERE id = 17827').get();

console.log('Job:', job.id, job.title, job.company);
console.log('Job description length:', job.description?.length);
console.log('Prof tex length:', prof.resume_tex?.length);
console.log('Doc tex length:', doc.resume_tex?.length);

const lines1 = prof.resume_tex.split('\n');
const lines2 = (doc.resume_tex || '').split('\n');
let diffCount = 0;
for (let i = 0; i < Math.max(lines1.length, lines2.length); i++) {
  if (lines1[i] !== lines2[i]) {
    diffCount++;
    console.log(`Line ${i+1}:`);
    console.log('  ORIGINAL:', lines1[i]);
    console.log('  TAILORED:', lines2[i]);
  }
}
console.log('Total diff lines:', diffCount);
