const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

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

if (tables.some(t => t.name === 'llm_providers')) {
  console.log('--- LLM PROVIDERS ---');
  console.log(db.prepare('SELECT * FROM llm_providers').all());
}
if (tables.some(t => t.name === 'auto_apply_settings')) {
  console.log('--- AUTO APPLY SETTINGS ---');
  console.log(db.prepare('SELECT * FROM auto_apply_settings').all());
}
if (tables.some(t => t.name === 'app_settings')) {
  console.log('--- APP SETTINGS ---');
  console.log(db.prepare('SELECT * FROM app_settings').all());
}
if (tables.some(t => t.name === 'job_documents')) {
  console.log('--- JOB DOCUMENTS COUNT ---');
  console.log(db.prepare('SELECT count(*) as c FROM job_documents').get());
  console.log(db.prepare('SELECT job_id, doc_type, length(content) as len, updated_at FROM job_documents ORDER BY updated_at DESC LIMIT 5').all());
}
