import db from '../src/lib/db';

const rows = db.prepare('SELECT cache_key, signature, computed_at, length(payload) as payload_len FROM match_cache').all();
console.log('match_cache rows:', rows);
