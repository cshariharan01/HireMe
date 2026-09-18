import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';

const GLOBAL_REMOTE_RE = /\b(work from anywhere|remote worldwide|remote \(global\)|open to international|globally remote|anywhere in the world|fully remote worldwide|remote from anywhere)\b/i;
const US_ONLY_RE = /\b(us(?:a)? only|u\.s\.? only|must be (?:a )?us (?:citizen|resident)|requires us work authorization|authorized to work in the (?:us|united states)|w-?2 only|us residents only|usa residents only|only open to us|based in the us|within the us|united states only|eligible to work in the us)\b/i;
const COUNTRY_RE = /\b(uk only|canada only|germany only|india only|australia only|eu only|within (?:the )?eea|netherlands only)\b/i;
const VISA_RE = /(visa sponsorship|we sponsor|sponsor(?:ing)? visas?|h-?1b|green card sponsor|work permit sponsor|will sponsor)/gi;
const RELOCATION_RE = /(relocation (?:assistance|package|support|help|bonus|benefits?)|relocation offered|will relocate|we'?ll relocate you|relocation available|relocation paid)/gi;
const NEGATION_RE = /\b(no|not|never|won'?t|will not|do not|don'?t|cannot|can not|unable|ineligible|without|nor|not be considered|not provide|not provided|not eligible|are unable to|aren'?t able|currently do not|isn'?t able|won t|no longer)\b/i;

function hasUnnegated(haystack: string, re: RegExp): boolean {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    const before = haystack.slice(Math.max(0, start - 80), start);
    const after = haystack.slice(end, Math.min(haystack.length, end + 60));
    if (NEGATION_RE.test(before) || NEGATION_RE.test(after)) continue;
    return true;
  }
  return false;
}

// India city/region keywords — for Naukri and Himalayas listings whose location
// field is a country/city string (vs. text-blob description).
const INDIA_LOCATION_RE = /\b(india|bengaluru|bangalore|mumbai|delhi|gurugram|noida|hyderabad|chennai|pune|kolkata|coimbatore|ahmedabad|jaipur|chandigarh|trivandrum|kochi|cochin|goa|mysuru|mysore|indore|nagpur)\b/i;

function classifyJob(source: string, title: string, description: string, location: string) {
  const haystack = `${title}\n${location}\n${description}`;
  let remote_policy: string;

  // India-located → "global" (= good for India user). This covers Naukri and Himalayas
  // whose location strings explicitly call out Indian cities or country.
  if (INDIA_LOCATION_RE.test(location)) {
    remote_policy = 'global';
  } else if (GLOBAL_REMOTE_RE.test(haystack)) {
    remote_policy = 'global';
  } else if (US_ONLY_RE.test(haystack)) {
    remote_policy = 'us-only';
  } else if (COUNTRY_RE.test(haystack)) {
    remote_policy = 'country-specific';
  } else if (location && /,\s*[A-Z]{2}\b/.test(location)) {
    // "City, ST" pattern → US-only (best guess)
    remote_policy = 'us-only';
  } else if (location && /\b(united states|usa|us)\b/i.test(location.trim()) && !/\bindia\b/i.test(location)) {
    remote_policy = 'us-only';
  } else {
    remote_policy = 'unknown';
  }

  return {
    remote_policy,
    visa_sponsorship: hasUnnegated(haystack, VISA_RE) ? 1 : 0,
    relocation_offered: hasUnnegated(haystack, RELOCATION_RE) ? 1 : 0,
  };
}

const db = new Database(path.join(process.cwd(), 'data', 'hiresignal.db'));
sqliteVec.load(db);
db.pragma('journal_mode = WAL');

// Ensure columns exist
for (const spec of ['remote_policy TEXT', 'visa_sponsorship INTEGER DEFAULT 0', 'relocation_offered INTEGER DEFAULT 0']) {
  try { db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`); }
  catch (e) { if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e; }
}

interface Row { id: number; source: string; title: string; description: string; location: string }
const rows = db.prepare('SELECT id, source, title, description, location FROM job_postings').all() as Row[];

const update = db.prepare('UPDATE job_postings SET remote_policy = ?, visa_sponsorship = ?, relocation_offered = ? WHERE id = ?');

const counts: Record<string, number> = { global: 0, 'us-only': 0, 'country-specific': 0, unknown: 0, visa: 0, relo: 0 };
const tx = db.transaction(() => {
  for (const r of rows) {
    const cls = classifyJob(r.source || '', r.title || '', r.description || '', r.location || '');
    update.run(cls.remote_policy, cls.visa_sponsorship, cls.relocation_offered, r.id);
    counts[cls.remote_policy] = (counts[cls.remote_policy] || 0) + 1;
    if (cls.visa_sponsorship) counts.visa++;
    if (cls.relocation_offered) counts.relo++;
  }
});
tx();

console.log(`Classified ${rows.length} jobs:`);
console.log(`  remote_policy: global=${counts.global}, us-only=${counts['us-only']}, country-specific=${counts['country-specific']}, unknown=${counts.unknown}`);
console.log(`  visa_sponsorship: ${counts.visa}`);
console.log(`  relocation_offered: ${counts.relo}`);

db.close();
