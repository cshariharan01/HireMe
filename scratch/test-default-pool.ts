import db from '../src/lib/db';
import { getRankedMatchById, computeRanked } from '../src/lib/matches';

async function test() {
  const o = { includeHidden: true, includeExpired: true, includeApplied: true, includeJobId: 1000055 };
  const res = computeRanked(o);
  const match = res?.ranked.find(m => m.id === 1000055);
  console.log('Match for Yantran in default pool:');
  console.log('Score:', match?.score);
  console.log('Title:', match?.title);
  console.log('Company:', match?.company);
  console.log('Source:', match?.source);
  console.log('ApplyType:', match?.applyType);
  console.log('Reasons:', match?.reasons);
  console.log('Breakdown:', (match as any)?.breakdown);
}

test().catch(console.error);
