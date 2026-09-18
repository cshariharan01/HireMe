const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

const job = db.prepare('SELECT id, title, company, description, url, source FROM job_postings WHERE id = 17827').get();
console.log('--- JOB 17827 ---');
console.log('Title:', job.title);
console.log('Company:', job.company);
console.log('Source:', job.source);
console.log('URL:', job.url);
console.log('Desc length:', job.description?.length);
console.log('Desc preview:\n', job.description?.slice(0, 500));

const match = db.prepare('SELECT * FROM match_cache WHERE job_id = 17827').get();
console.log('--- MATCH CACHE ---');
console.log(match);

const doc = db.prepare('SELECT * FROM job_documents WHERE job_id = 17827').get();
console.log('--- JOB DOCS ---');
console.log('Has resume_tex:', !!doc?.resume_tex, 'length:', doc?.resume_tex?.length);
console.log('Has resume_variant:', !!doc?.resume_variant);
console.log('Cover letter length:', doc?.cover_letter?.length);
