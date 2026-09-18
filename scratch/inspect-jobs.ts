import db from '../src/lib/db';
import { buildMatchesPage, getCandidatePreferences } from '../src/lib/matches-page';

const profileRow = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get();
console.log('Profile:', profileRow ? JSON.parse(profileRow.parsed_json) : null);

const prefs = getCandidatePreferences();
console.log('Candidate Preferences:', prefs);

const page = buildMatchesPage({ limit: 50 });
console.log('Total matches returned on page:', page.matches.length);
page.matches.forEach((m, idx) => {
  console.log(`[#${idx + 1}] ID=${m.id} | Title: "${m.title}" | Company: "${m.company}" | ExpMin: ${m.facts?.experienceMin} | ExpMax: ${m.facts?.experienceMax} | ExpText: "${m.facts?.experienceText}" | URL: ${m.url}`);
});
