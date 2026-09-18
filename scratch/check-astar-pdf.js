const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');
const pdfParse = require('pdf-parse');

async function main() {
  // 1. Profile original PDF
  const p = db.prepare('SELECT pdf_blob, pdf_filename, resume_tex FROM my_profile WHERE id = 1').get();
  if (p.pdf_blob) {
    const origParsed = await pdfParse(p.pdf_blob);
    console.log('=== ORIGINAL PDF IN my_profile ===');
    console.log('Filename:', p.pdf_filename);
    console.log('Text (first 600 chars):');
    console.log(origParsed.text.slice(0, 600));
  }

  // 2. What about the PDF compiled for job 1000056?
  // Let's check job_documents for 1000056
  const docs = db.prepare('SELECT * FROM job_documents WHERE job_id = 1000056').all();
  console.log('\n=== job_documents for 1000056 ===', docs);

  // 3. Application resume_tex
  const app = db.prepare('SELECT resume_tex, resume_variant FROM my_applications WHERE job_id = 1000056').get();
  console.log('\n=== Application resume_tex length:', app?.resume_tex?.length);
  console.log('Application resume_variant (markdown) length:', app?.resume_variant?.length);
}

main().catch(console.error);
