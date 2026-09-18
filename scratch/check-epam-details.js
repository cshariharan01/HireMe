const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

console.log('--- Job 1000067 ---');
console.log(db.prepare("SELECT * FROM job_postings WHERE id = 1000067").get());

console.log('--- Job 1000063 ---');
console.log(db.prepare("SELECT * FROM job_postings WHERE id = 1000063").get());

console.log('--- Job 1000064 ---');
console.log(db.prepare("SELECT * FROM job_postings WHERE id = 1000064").get());

console.log('--- Job 1000065 ---');
console.log(db.prepare("SELECT * FROM job_postings WHERE id = 1000065").get());

console.log('--- Audits for 1000063, 1000064, 1000065, 1000067 ---');
console.log(db.prepare("SELECT * FROM apply_audit WHERE job_id IN (1000063, 1000064, 1000065, 1000067)").all());
