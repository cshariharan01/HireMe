import db from '../src/lib/db';
import { generateLatexResume } from '../src/lib/llm';
import { compileLatex } from '../src/lib/apply/latex';

async function test() {
  const job = db.prepare('SELECT * FROM job_postings WHERE id = 1000055').get() as any;
  const profileRow = db.prepare('SELECT parsed_json, resume_tex, pdf_filename FROM my_profile WHERE id = 1').get() as any;
  const profile = JSON.parse(profileRow.parsed_json);

  console.log('Generating LaTeX with Ollama (since gemini-3.6-flash is invalid)...');
  const result = await generateLatexResume(
    profile,
    profileRow.resume_tex,
    job.title,
    job.company,
    job.description || '',
    { interactive: true }
  );

  console.log('Result text length:', result.text.length);
  try {
    const pdf = await compileLatex(result.text);
    console.log('Compile SUCCESS! PDF bytes:', pdf.length);
  } catch (e: any) {
    console.error('COMPILE ERROR:', e.message);
    // Print lines around error or entire text
    const fs = await import('fs');
    fs.writeFileSync('scratch/failed-yantran.tex', result.text, 'utf8');
    console.log('Saved scratch/failed-yantran.tex');
  }
}

test();
