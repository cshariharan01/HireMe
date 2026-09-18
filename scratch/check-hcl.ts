import db from '../src/lib/db';

const audit18120 = db.prepare('SELECT * FROM apply_audit WHERE job_id = 18120').all();
console.log('Audit 18120:', audit18120);

const app18120 = db.prepare('SELECT * FROM my_applications WHERE job_id = 18120').get() as any;
console.log('App 18120 resume_tex preview:', app18120?.resume_tex?.slice(0, 400));

const audit18060 = db.prepare('SELECT * FROM apply_audit WHERE job_id = 18060').all();
console.log('Audit 18060:', audit18060);
