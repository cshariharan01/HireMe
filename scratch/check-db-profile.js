const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

const resumes = db.prepare('SELECT id, label, pdf_filename, is_active, length(pdf_blob) as bytes FROM resumes').all();
console.log('Resumes in DB:', resumes);
