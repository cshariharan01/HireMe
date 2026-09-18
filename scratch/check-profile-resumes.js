const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

console.log('--- my_profile ---');
const profile = db.prepare("SELECT * FROM my_profile").all();
for (const p of profile) {
  console.log({
    id: p.id,
    full_name: p.full_name,
    target_role: p.target_role,
    resume_filename: p.resume_filename,
    resume_pdf_path: p.resume_pdf_path,
    resume_path: p.resume_path,
    has_resume_pdf_blob: !!p.resume_pdf,
    resume_pdf_size: p.resume_pdf ? p.resume_pdf.length : 0,
    has_resume_latex: !!p.resume_latex,
    has_resume_markdown: !!p.resume_markdown,
    default_template: p.default_template
  });
}

console.log('\n--- resumes ---');
const resumes = db.prepare("SELECT id, name, target_role, is_default, created_at, length(latex_content) as latex_len, length(pdf_data) as pdf_len, length(content) as content_len FROM resumes").all();
console.log(resumes);
