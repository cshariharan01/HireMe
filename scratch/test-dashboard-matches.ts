import { buildMatchesPage, getCandidatePreferences } from '../src/lib/matches-page';

const prefs = getCandidatePreferences();
console.log('Candidate Preferences:', prefs);

const page = buildMatchesPage({ limit: 50 });
console.log('\nTotal dashboard matches returned:', page.matches.length);

console.log('\nTop 25 jobs currently shown on dashboard:');
page.matches.slice(0, 25).forEach((m, idx) => {
  console.log(`[#${idx + 1}] ID=${m.id} | "${m.title}" | Company: "${m.company}" | ExpMin: ${m.facts?.experienceMin} | ExpMax: ${m.facts?.experienceMax} | ExpText: "${m.facts?.experienceText}"`);
});

// Check if any Lead / Principal / Architect or >3.6 YOE jobs are present
const invalid = page.matches.filter(m => {
  const isLead = /\b(lead|principal|staff|architect|director|head\s+of|manager|vp)\b/i.test(m.title);
  const min = m.facts?.experienceMin;
  const isTooSeniorExp = min != null && min > prefs.yearsOfExperience;
  return isLead || isTooSeniorExp;
});

console.log('\nAny invalid (Lead/Principal/Too Senior) jobs found on dashboard?', invalid.length);
if (invalid.length > 0) {
  console.log('Invalid jobs:', invalid.map(m => ({ id: m.id, title: m.title, exp: m.facts?.experienceText })));
}
