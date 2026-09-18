import db from '../src/lib/db';
import { generateLatexResume } from '../src/lib/llm';
import { compileLatex, compileLatexWithRepair, spliceLatexContent } from '../src/lib/apply/latex';
import { calculateAndStoreTailoredScore } from '../src/lib/tailored-score';

async function run() {
  const jobId = 1000055;
  const job = db.prepare('SELECT * FROM job_postings WHERE id = ?').get(jobId) as any;
  const profileRow = db.prepare('SELECT parsed_json, resume_tex, pdf_filename FROM my_profile WHERE id = 1').get() as any;
  const profile = JSON.parse(profileRow.parsed_json);

  console.log(`Job: ${job.title} at ${job.company}`);

  // Test generation
  console.log('Generating LaTeX resume for Yantran...');
  const res = await generateLatexResume(
    profile,
    profileRow.resume_tex,
    job.title,
    job.company,
    job.description || '',
    { interactive: true }
  );

  console.log('Generated tex length:', res.text.length);

  // Compile
  const { bytes, tex } = await compileLatexWithRepair(
    res.text,
    (err) => generateLatexResume(profile, profileRow.resume_tex, job.title, job.company, job.description || '', { interactive: true, fixHint: err }).then(r => r.text)
  );

  console.log('Successfully compiled PDF! Bytes:', bytes.length);

  // Update DB for Yantran
  db.prepare(`
    UPDATE my_applications
    SET resume_tex = ?,
        resume_variant = NULL
    WHERE job_id = ?
  `).run(tex, jobId);

  db.prepare(`
    INSERT INTO job_documents (job_id, resume_tex, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(job_id) DO UPDATE SET resume_tex = excluded.resume_tex, updated_at = CURRENT_TIMESTAMP
  `).run(jobId, tex);

  // Calculate new score
  const scoreResult = await calculateAndStoreTailoredScore(jobId);
  console.log('New Score Result for Yantran:', scoreResult);

  const updated = db.prepare('SELECT id, job_id, tailored_score, default_score, LENGTH(resume_tex) as tex_len, resume_variant FROM my_applications WHERE job_id = ?').get(jobId);
  console.log('Updated application row in DB:', updated);
}

run().catch(e => console.error('Error:', e));
