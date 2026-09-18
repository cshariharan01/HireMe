import db from '../src/lib/db';

const providers = db.prepare('SELECT * FROM llm_providers').all();
console.log('LLM Providers in DB:', providers);
