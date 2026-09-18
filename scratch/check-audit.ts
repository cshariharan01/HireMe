import db from '../src/lib/db';

const audits = db.prepare('SELECT * FROM apply_audit WHERE job_id = 1000055 ORDER BY id DESC').all();
console.log('Audits for Yantran:', audits);
