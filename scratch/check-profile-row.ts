import db from '../src/lib/db';

const row = db.prepare('SELECT * FROM my_profile WHERE id = 1').get();
console.log('Profile row:', row);
