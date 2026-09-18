const Database = require('better-sqlite3');
for (const f of ['data/hiresignal-personal.db', 'data/db.sqlite']) {
  try {
    const db = new Database(f);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log(f, 'tables:', tables.map(t => t.name).join(', '));
    if (tables.some(t => t.name === 'my_profile')) {
      const p = db.prepare('SELECT id, pdf_filename, length(resume_tex) as tex_len, updated_at FROM my_profile').all();
      console.log(f, 'my_profile:', p);
    }
    if (tables.some(t => t.name === 'resumes')) {
      const r = db.prepare('SELECT id, label, is_active, pdf_filename, length(resume_tex) as tex_len, updated_at FROM resumes').all();
      console.log(f, 'resumes:', r);
    }
  } catch (e) {
    console.log(f, 'error:', e.message);
  }
}
