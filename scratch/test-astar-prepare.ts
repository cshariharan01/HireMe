import { prepareSubmission } from '../src/lib/apply/prepare';
import { hasLatexCompiler } from '../src/lib/apply/latex';
import pdfParse from 'pdf-parse';

async function main() {
  const compiler = await hasLatexCompiler();
  console.log('hasLatexCompiler():', compiler);

  const res = await prepareSubmission(1000056, { generateMissing: false });
  console.log('prepareSubmission ok:', res.ok, 'strategy:', res.strategy);
  console.log('warnings:', res.warnings);
  if (res.plan) {
    const resume = res.plan.attachments.resume;
    console.log('resume attachment filename:', resume?.filename);
    console.log('resume attachment bytes length:', resume?.bytes?.length);
    if (resume?.bytes) {
      const parsed = await pdfParse(Buffer.from(resume.bytes));
      console.log('=== PDF TEXT (first 1000 chars) ===');
      console.log(parsed.text.slice(0, 1000));
    }
  }
}

main().catch(console.error);
