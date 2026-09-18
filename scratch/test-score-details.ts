import db from '../src/lib/db';
import { getTailoredMatchScore } from '../src/lib/matches';
import { stripLatexToText } from '../src/lib/tailored-score';

async function test() {
  const app = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;
  const stripped = stripLatexToText(app.resume_tex);
  const res = await getTailoredMatchScore(1000055, stripped);

  console.log('tailoredMatch score:', res?.tailoredMatch.score);
  console.log('defaultMatch score:', res?.defaultMatch?.score);
  console.log('tailoredMatch reasons:', res?.tailoredMatch.reasons);
  console.log('defaultMatch reasons:', res?.defaultMatch?.reasons);
}

test().catch(console.error);
