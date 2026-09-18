process.env.PATH = (process.env.PATH || '').replace(/;[^;]*MiKTeX[^;]*/g, '');
const { generateLatexResume } = require('../src/lib/llm');
const { compileLatex, clearLatexCompilerCache } = require('../src/lib/apply/latex');
const db = require('../src/lib/db').default;

async function main() {
  clearLatexCompilerCache();
  const job = db.prepare(`SELECT title, company, description FROM job_postings WHERE url_status IS NOT 'dead' ORDER BY id DESC LIMIT 1`).get();
  console.log('JOB:', JSON.stringify({ title: job.title, company: job.company }));
  const profile = db.prepare('SELECT parsed_json, resume_tex FROM my_profile WHERE id=1').get();
  const pj = JSON.parse(profile.parsed_json || '{}');
  console.log('profile keys:', Object.keys(pj).join(','));
  console.log('resume_tex len:', profile.resume_tex ? profile.resume_tex.length : 0);

  const t = Date.now();
  const result = await generateLatexResume(pj, profile.resume_tex, job.title, job.company, job.description || '', { interactive: true });
  console.log('GENERATED in ms', Date.now() - t, '| tex len', result.text.length, '| coverage', JSON.stringify(result.coverage));
  require('fs').writeFileSync('C:/Users/cshar/AppData/Local/Temp/gen-resume.tex', result.text);
  const { splitLatexDocument } = require('../src/lib/apply/latex');
  const parts = splitLatexDocument(result.text);
  console.log('spliced doc — preamble len', parts.preamble.length, '| body len', parts.body.length);
  const open = (result.text.match(/\{/g) || []).length;
  const close = (result.text.match(/\}/g) || []).length;
  console.log('braces open', open, 'close', close, 'diff', open - close);
  console.log('saved temp tex for manual inspection');
  try {
    const pdf = await compileLatex(result.text, 180000);
    console.log('COMPILED OK bytes', pdf.length);
  } catch (e) {
    console.error('COMPILE FAILED (see temp dirs/miktex log)');
  }
}

main().catch((e) => { console.error('FAILED:', (e as Error).message.slice(0, 600)); process.exit(1); });