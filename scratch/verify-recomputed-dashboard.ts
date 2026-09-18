import db from '../src/lib/db';
import { buildMatchesPage, getCandidatePreferences } from '../src/lib/matches-page';

// Clear stale match_cache
db.prepare('DELETE FROM match_cache').run();
console.log('Cleared match_cache');

const prefs = getCandidatePreferences();
console.log('Candidate Preferences:', prefs);

const page = buildMatchesPage({ refresh: true, limit: 100 });
console.log('Total dashboard matches returned:', page.matches.length);

const job18000 = page.matches.find(m => m.id === 18000 || m.company.includes('Tata') && m.title.includes('GCP Data'));
console.log('Is TCS GCP Data Engineer (Job 18000) present?', !!job18000);
if (job18000) {
  console.log('Found job:', {
    id: job18000.id,
    title: job18000.title,
    company: job18000.company,
    facts: job18000.facts
  });
}

// Check if ANY job requiring >3.6 YOE is present
const tooSenior = page.matches.filter(m => {
  const min = m.facts?.experienceMin;
  return min != null && min > prefs.yearsOfExperience;
});
console.log('Jobs with experience requirement > 3 YOE:', tooSenior.length);
if (tooSenior.length > 0) {
  console.log(tooSenior.map(m => ({ id: m.id, title: m.title, exp: m.facts?.experienceText })));
}

console.log('\nTop 15 jobs currently on dashboard:');
page.matches.slice(0, 15).forEach((m, idx) => {
  console.log(`[#${idx + 1}] ID=${m.id} | "${m.title}" | "${m.company}" | Exp: ${m.facts?.experienceText || 'not specified'}`);
});
