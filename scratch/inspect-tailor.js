const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

console.log('--- PROFILE ---');
const profile = db.prepare('SELECT id, pdf_filename, length(pdf_blob) as pdf_len, length(raw_text) as raw_len, length(parsed_json) as json_len, length(resume_tex) as tex_len FROM my_profile').all();
console.log(profile);

console.log('--- LLM PROVIDERS ---');
const providers = db.prepare('SELECT id, kind, model, is_active, is_creative, base_url FROM llm_providers').all();
console.log(providers);

console.log('--- TABLES ---');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables.map(t => t.name));

console.log('--- ENV VARS ---');
console.log({
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'SET (' + process.env.GEMINI_API_KEY.slice(0, 8) + '...)' : 'UNSET',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'SET' : 'UNSET',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'SET' : 'UNSET',
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'default',
});

if (tables.some(t => t.name === 'auto_apply_settings')) {
  console.log('--- AUTO APPLY SETTINGS ---');
  console.log(db.prepare('SELECT * FROM auto_apply_settings').all());
}
if (tables.some(t => t.name === 'app_settings')) {
  console.log('--- APP SETTINGS ---');
  console.log(db.prepare('SELECT * FROM app_settings').all());
}
if (tables.some(t => t.name === 'job_documents')) {
  console.log('--- JOB DOCUMENTS ---');
  console.log(db.prepare('SELECT * FROM job_documents').all());
}
