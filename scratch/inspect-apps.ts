import db from '../src/lib/db';

const apps = db.prepare(`
  SELECT a.id, a.job_id, j.title, j.company, j.source, j.source_platform,
         a.status, a.tailored_score, a.default_score,
         LENGTH(a.resume_variant) as md_len,
         LENGTH(a.resume_tex) as tex_len,
         a.applied_date
  FROM my_applications a
  JOIN job_postings j ON a.job_id = j.id
  ORDER BY a.id DESC LIMIT 10
`).all();

console.log('Recent applications:', apps);

const profile = db.prepare('SELECT resume_tex, pdf_filename FROM my_profile WHERE id = 1').get() as any;
console.log('Profile resume_tex preview:', profile.resume_tex?.slice(0, 300));
console.log('Profile pdf_filename:', profile.pdf_filename);
