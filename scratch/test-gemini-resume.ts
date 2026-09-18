import db from '../src/lib/db';
import { generateLatexResume } from '../src/lib/llm';

async function test() {
  const job = db.prepare('SELECT title, company, description FROM job_postings WHERE id = 1000055').get() as any;
  const profRow = db.prepare('SELECT parsed_json, resume_tex FROM my_profile WHERE id = 1').get() as any;
  const profile = JSON.parse(profRow.parsed_json);

  console.log('Testing generateLatexResume with Gemini 3.6 Flash...');
  const t0 = Date.now();
  const res = await generateLatexResume(
    profile,
    profRow.resume_tex,
    job.title,
    job.company,
    job.description || '',
    { interactive: true }
  );

  console.log(`Generated in ${(Date.now() - t0) / 1000}s!`);
  console.log('Text length:', res.text.length);
  console.log('Keywords coverage:', res.coverage);

  const summary = res.text.match(/\\section\{Summary\}[\s\S]*?(?=\\section)/);
  if (summary) console.log('\nGenerated Summary:\n', summary[0]);

  const skills = res.text.match(/\\section\{Skills\}[\s\S]*?(?=\\section)/);
  if (skills) console.log('\nGenerated Skills:\n', skills[0]);
}

test().catch(console.error);
