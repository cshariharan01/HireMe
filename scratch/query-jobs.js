const db = require('better-sqlite3')('data/hiresignal.db');
const cols = db.prepare("PRAGMA table_info(job_postings)").all();
console.log('Columns:', cols.map(c => c.name));
const rows = db.prepare("SELECT id, title, company, url, apply_type FROM job_postings WHERE url LIKE '%linkedin.com%' ORDER BY id DESC LIMIT 3").all();
console.log('LinkedIn jobs:', rows);
