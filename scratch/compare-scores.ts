import db from '../src/lib/db';
import { getTailoredMatchScore } from '../src/lib/matches';
import { stripLatexToText } from '../src/lib/tailored-score';

async function check() {
  const yApp = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;
  const hApp = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 18120').get() as any;

  console.log('--- HCLTech (18120) ---');
  const hStripped = stripLatexToText(hApp.resume_tex);
  console.log('HCLTech stripped preview:', hStripped.slice(0, 200));
  const hRes = await getTailoredMatchScore(18120, hStripped);
  console.log('HCLTech score:', hRes?.tailoredMatch.score, 'default:', hRes?.defaultMatch?.score);
  console.log('HCLTech breakdown:', hRes?.tailoredMatch.breakdown);

  console.log('--- Yantran (1000055) ---');
  const yStripped = stripLatexToText(yApp.resume_tex);
  console.log('Yantran stripped preview:', yStripped.slice(0, 200));
  const yRes = await getTailoredMatchScore(1000055, yStripped);
  console.log('Yantran score:', yRes?.tailoredMatch.score, 'default:', yRes?.defaultMatch?.score);
  console.log('Yantran breakdown:', yRes?.tailoredMatch.breakdown);
}

check().catch(console.error);
