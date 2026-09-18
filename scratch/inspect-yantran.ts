import db from '../src/lib/db';

const profileCols = db.prepare("PRAGMA table_info(my_profile)").all();
console.log('my_profile cols:', profileCols.map((c: any) => c.name));

const profile = db.prepare('SELECT * FROM my_profile WHERE id = 1').get() as any;
console.log('Profile non-null fields:', Object.keys(profile).filter(k => profile[k] !== null && k !== 'pdf_blob'));


const yantranJob = db.prepare("SELECT id, title, company, url, source, source_platform, apply_type FROM job_postings WHERE company LIKE '%Yantran%' OR title LIKE '%Yantran%'").all();
console.log('Yantran job:', yantranJob);

const yantranApp = db.prepare("SELECT a.id, a.job_id, a.status, a.tailored_score, a.default_score, a.applied_date, LENGTH(a.resume_variant) as var_len, LENGTH(a.resume_tex) as tex_len, SUBSTR(a.resume_variant, 1, 300) as var_preview FROM my_applications a JOIN job_postings j ON a.job_id = j.id WHERE j.company LIKE '%Yantran%'").all();
console.log('Yantran app:', yantranApp);

const docs = db.prepare("SELECT d.job_id, LENGTH(d.resume_variant) as var_len, LENGTH(d.resume_tex) as tex_len, d.tailored_score, d.default_score, SUBSTR(d.resume_variant, 1, 200) as var_preview FROM job_documents d JOIN job_postings j ON d.job_id = j.id WHERE j.company LIKE '%Yantran%'").all();
console.log('Yantran docs:', docs);
