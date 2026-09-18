const Database = require('better-sqlite3');
const db = new Database('data/hiresignal.db');

db.prepare("UPDATE llm_providers SET model = 'gemini-3.6-flash', is_creative = 1 WHERE id = 1").run();
console.log('Updated llm_providers:', db.prepare('SELECT id, kind, model, is_active, is_creative FROM llm_providers').all());
