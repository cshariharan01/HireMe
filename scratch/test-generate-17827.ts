import Database from 'better-sqlite3';
import { generateLatexResume } from '../src/lib/llm';

async function run() {
  const db = new Database('data/hiresignal.db');
  const profRow = db.prepare('SELECT parsed_json, resume_tex FROM my_profile WHERE id = 1').get() as any;
  const profile = JSON.parse(profRow.parsed_json);
  const job = db.prepare('SELECT id, title, company, description FROM job_postings WHERE id = 17827').get() as any;

  console.log('Testing generateLatexResume for job 17827...');
  console.log('Job:', job.title, '@', job.company);

  const t0 = Date.now();
  try {
    const res = await generateLatexResume(profile, profRow.resume_tex, job.title, job.company, job.description, { interactive: true });
    console.log('Finished in', Date.now() - t0, 'ms');
    console.log('Result text length:', res.text.length);
    console.log('Original tex length:', profRow.resume_tex.length);
    console.log('Coverage:', res.coverage);

    const origSummary = profRow.resume_tex.slice(profRow.resume_tex.indexOf('\\section{Summary}'), profRow.resume_tex.indexOf('\\section{Experience}'));
    const genSummary = res.text.slice(res.text.indexOf('\\section{Summary}'), res.text.indexOf('\\section{Experience}'));
    console.log('\n--- ORIGINAL SUMMARY & SKILLS ---\n', origSummary);
    console.log('\n--- GENERATED SUMMARY & SKILLS ---\n', genSummary);
  } catch (e: any) {
    console.error('generateLatexResume error:', e.message);
  }
}

run();
