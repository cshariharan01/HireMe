import db from '../src/lib/db';

const j = db.prepare('SELECT id, title, description FROM job_postings WHERE id = 18121').get() as any;
console.log(j.description);
