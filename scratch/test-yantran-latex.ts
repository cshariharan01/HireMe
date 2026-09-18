import db from '../src/lib/db';
import { generateLatexResume } from '../src/lib/llm';
import { compileLatexWithRepair } from '../src/lib/apply/latex';

async function test() {
  const job = db.prepare('SELECT * FROM job_postings WHERE id = 1000055').get() as any;
  const profileRow = db.prepare('SELECT parsed_json, resume_tex, pdf_filename FROM my_profile WHERE id = 1').get() as any;
  const profile = JSON.parse(profileRow.parsed_json);

  console.log('Job:', job.title, job.company);
  console.log('Template length:', profileRow.resume_tex?.length);

  try {
    console.log('Calling generateLatexResume...');
    const result = await generateLatexResume(
      profile,
      profileRow.resume_tex,
      job.title,
      job.company,
      job.description || '',
      { interactive: true }
    );
    console.log('Generated tex length:', result.text.length);
    console.log('Compiling...');
    const compiled = await compileLatexWithRepair(result.text);
    console.log('Compiled PDF bytes:', compiled.bytes.length);
  } catch (e: any) {
    console.error('FAILED:', e.message);
  }
}

test();
