import db from '../src/lib/db';
import { generateLatexResume } from '../src/lib/llm';
import { compileLatexWithRepair } from '../src/lib/apply/latex';
import { calculateAndStoreTailoredScore } from '../src/lib/tailored-score';

async function test() {
  const jobId = 1000055;
  const job = db.prepare('SELECT title, company, description FROM job_postings WHERE id = ?').get(jobId) as any;
  const profRow = db.prepare('SELECT parsed_json, resume_tex FROM my_profile WHERE id = 1').get() as any;
  const profile = JSON.parse(profRow.parsed_json);

  console.log('Generating with Gemini 3.6 Flash...');
  const res = await generateLatexResume(
    profile,
    profRow.resume_tex,
    job.title,
    job.company,
    job.description || '',
    { interactive: true }
  );

  console.log('Compiling PDF with pdflatex...');
  const { bytes, tex } = await compileLatexWithRepair(
    res.text,
    async () => res.text
  );
  console.log('PDF Compiled! Bytes:', bytes.length);

  // Save to DB
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

  console.log('Calculating tailored score...');
  const scoreResult = await calculateAndStoreTailoredScore(jobId);
  console.log('Score Result:', scoreResult);

  const updated = db.prepare('SELECT id, job_id, default_score, tailored_score, LENGTH(resume_tex) as tex_len FROM my_applications WHERE job_id = ?').get(jobId);
  console.log('Updated my_applications:', updated);
}

test().catch(console.error);
