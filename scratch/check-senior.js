const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

const total = db.prepare('SELECT count(*) as c FROM job_postings').get().c;
const senior = db.prepare("SELECT count(*) as c FROM job_postings WHERE title LIKE '%senior%' OR title LIKE '%sr.%' OR title LIKE '%lead%'").get().c;
console.log('Total jobs in DB:', total);
console.log('Senior / Lead jobs in DB:', senior);
