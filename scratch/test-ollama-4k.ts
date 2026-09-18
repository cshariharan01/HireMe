import db from '../src/lib/db';
import { ollamaGenerate } from '../src/lib/llm';
import { compileLatex, spliceLatexContent } from '../src/lib/apply/latex';
import { extractJdKeywords } from '../src/lib/jd-keywords';

async function test() {
  const job = db.prepare('SELECT * FROM job_postings WHERE id = 1000055').get() as any;
  const profileRow = db.prepare('SELECT parsed_json, resume_tex, pdf_filename FROM my_profile WHERE id = 1').get() as any;
  const profile = JSON.parse(profileRow.parsed_json);

  const keywords = extractJdKeywords(job.description, job.title, 15);
  const requiredList = keywords.map((k) => k.term);
  const keywordsBlock = requiredList.length
    ? `\n\nREQUIRED ATS KEYWORDS (Ensure all these terms appear verbatim in \\section{Skills} and are seamlessly incorporated into experience / project bullets to achieve 99% ATS match):\n${requiredList.join(', ')}\n`
    : '';

  const { RESUME_LATEX_RULES } = await import('../src/lib/llm');

  const prompt = `${RESUME_LATEX_RULES}
${keywordsBlock}
PARSED RESUME (facts):
${JSON.stringify(profile, null, 2)}

TARGET JOB TITLE: ${job.title}
TARGET COMPANY: ${company}

JOB DESCRIPTION:
${job.description.slice(0, 4000)}

CANDIDATE'S LATEX TEMPLATE (edit its CONTENT, keep its design):
---
${profileRow.resume_tex.slice(0, 20000)}
---

Write the tailored .tex now:`;

  console.log('Generating with Ollama, num_predict = 4096...');
  const text = await ollamaGenerate(prompt, undefined, undefined, 4096, 240000);
  console.log('Generated text length:', text.length);

  const spliced = spliceLatexContent(profileRow.resume_tex, text);
  console.log('Spliced length:', spliced.length);

  const pdf = await compileLatex(spliced);
  console.log('SUCCESS! Compiled PDF bytes:', pdf.length);
}

const company = 'Yantran';
test().catch(e => console.error('FAILED:', e));
