const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

const p = db.prepare('SELECT id, parsed_json, resume_tex, updated_at FROM my_profile').get();
console.log('my_profile updated_at:', p.updated_at);
console.log('my_profile parsed_json:', JSON.parse(p.parsed_json));
console.log('\n--- my_profile resume_tex (first 1000 chars) ---');
console.log(p.resume_tex.slice(0, 1000));

const r = db.prepare('SELECT * FROM resumes').all();
console.log('\n--- resumes count:', r.length);
for (const row of r) {
  console.log('resume id:', row.id, 'label:', row.label, 'is_active:', row.is_active, 'updated_at:', row.updated_at);
}

const app = db.prepare('SELECT * FROM my_applications WHERE job_id = 1000056').get();
console.log('\n--- my_applications for 1000056:');
console.log('resume_source:', app.resume_source);
console.log('applied_at:', app.applied_at);
console.log('resume_tex first 500 chars:', app.resume_tex?.slice(0, 500));
