import { calculateAndStoreTailoredScore } from '../src/lib/tailored-score';
import db from '../src/lib/db';

async function run() {
  console.log('Calculating score for Yantran (1000055)...');
  const res = await calculateAndStoreTailoredScore(1000055);
  console.log('calculateAndStoreTailoredScore result:', res);

  const row = db.prepare('SELECT id, job_id, default_score, tailored_score FROM my_applications WHERE job_id = 1000055').get();
  console.log('Updated my_applications row:', row);
}

run().catch(console.error);
