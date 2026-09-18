// ingest-jobspy.ts — Indeed + LinkedIn via the `ts-jobspy` library.
//
// WHY THIS SOURCE EXISTS (spike verdict: GO — see scripts/spike-jobspy.ts):
//   - **Recency.** It is the ONLY ingest source with a real date filter. `hoursOld` bounds the
//     request at the source, so this can never do what the old HN query did (pull 2015 threads).
//     No other script here has any date filtering at all.
//   - **posted_at coverage.** The spike measured 100% `datePosted` on both sites. 41% of our
//     existing active rows have posted_at = NULL, which is precisely why prune's posting-age rule
//     is blind to them and why the freshness signal can't score them.
//   - **Speed.** Indeed returned 12 full descriptions in 2.7s. Our hand-rolled LinkedIn scraper
//     spends 6 SECONDS PER JOB fetching details one at a time.
//   - **Indeed is genuinely new** — we had no Indeed source (the old RSS approach is dead).
//
// Only linkedin + indeed are used: the library's own docs mark Glassdoor / ZipRecruiter / Google
// as under maintenance, and its Naukri class is untested here (our own Naukri scraper is
// Akamai-blocked, so treat that one as unproven rather than a fix).
//
// Follows the established ingest conventions deliberately (see CLAUDE.md): standalone script, its
// own DB handle, inline schema + ontology copy, upsert on dedup_hash, embedding left NULL for
// `npm run embed`. The inline duplication is intentional in this project.
//
// Run: npx ts-node scripts/ingest-jobspy.ts
//   JOBSPY_HOURS=168        recency window in hours (default 168 = 7 days)
//   JOBSPY_WANTED=25        results per (role x site) query
//   JOBSPY_SITES=indeed,linkedin
//   JOBSPY_LOCATIONS=India,Remote

import './shared/env';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { scrapeJobs } from 'ts-jobspy';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';
import { getEnabledRoles } from './shared/profile-roles';
import { isSeniorRelevant } from '../src/lib/seniority';

const SOURCE = 'jobspy';

// --- inline ontology copy (see CLAUDE.md: intentional duplication across ingest scripts) ---
const ALL_TERMS = [
  'FHIR R4', 'FHIR STU3', 'FHIR R5', 'HL7', 'HL7 v2', 'HL7 CDA',
  'SMART on FHIR', 'CDS Hooks', 'Bulk FHIR', 'FHIR API', 'HL7 FHIR',
  'Epic', 'Cerner', 'Oracle Health', 'Meditech', 'Allscripts',
  'CMS', 'ONC', 'HIPAA', 'USCDI', 'TEFCA', 'Prior Auth',
  'interoperability', 'HITECH', 'PHI', 'CCDA', 'C-CDA',
  'Mirth Connect', 'Azure Health Data Services',
  'AWS HealthLake', 'DICOM', 'IHE', 'SNOMED', 'LOINC', 'ICD-10', 'RxNorm',
];

function isDomainPriority(text: string): boolean {
  const lower = text.toLowerCase();
  let count = 0;
  for (const term of ALL_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      count++;
      if (count >= 3) return true;
    }
  }
  return false;
}

// --- inline job classifier copy (keep in sync with src/lib/job-classifier.ts) ---
const NEGATION_RE = /\b(no|not|without|cannot|can't|unable to|do not|does not)\s+(\w+\s+){0,3}$/i;
const GLOBAL_REMOTE_RE = /\b(remote[- ]?(first|friendly|global|worldwide|anywhere)|work from anywhere|fully remote|100% remote|globally remote)\b/i;
const US_ONLY_RE = /\b(us[- ]?only|must be (located|based) in the (us|united states)|us (citizens?|residents?) only|authorized to work in the us|eligible to work in the us)\b/i;
const COUNTRY_RE = /\b(india|bengaluru|bangalore|pune|hyderabad|mumbai|chennai|delhi|noida|gurgaon|gurugram)\b/i;
const VISA_RE = /\b(visa sponsorship|sponsor(ship)? (available|provided)|h1b|h-1b|work permit)\b/i;
const RELOCATION_RE = /\b(relocation (assistance|support|package|offered)|will relocate|relocation provided)\b/i;

function hasUnnegated(haystack: string, re: RegExp): boolean {
  const m = re.exec(haystack);
  if (!m) return false;
  const before = haystack.slice(Math.max(0, m.index - 60), m.index);
  return !NEGATION_RE.test(before);
}

function classifyJob(title: string, description: string, location: string) {
  const haystack = `${title}\n${location}\n${description}`;
  let remote_policy: string;
  if (GLOBAL_REMOTE_RE.test(haystack)) remote_policy = 'global';
  else if (US_ONLY_RE.test(haystack)) remote_policy = 'us-only';
  else if (COUNTRY_RE.test(haystack)) remote_policy = 'country-specific';
  else remote_policy = 'unknown';
  return {
    remote_policy,
    visa_sponsorship: hasUnnegated(haystack, VISA_RE) ? 1 : 0,
    relocation_offered: hasUnnegated(haystack, RELOCATION_RE) ? 1 : 0,
  };
}

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hiresignal.db'));
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
// Sources run concurrently via ingest-all.ts; WAL permits one writer, so wait rather than fail.
db.pragma('busy_timeout = 15000');

db.exec(`
  CREATE TABLE IF NOT EXISTS job_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT, company TEXT, title TEXT, location TEXT,
    description TEXT, url TEXT, embedding BLOB,
    domain_priority INTEGER DEFAULT 0, dedup_hash TEXT UNIQUE,
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
ensureFreshnessColumns(db);
for (const spec of ['remote_policy TEXT', 'visa_sponsorship INTEGER DEFAULT 0', 'relocation_offered INTEGER DEFAULT 0', "apply_type TEXT DEFAULT 'unknown'", 'source_platform TEXT']) {
  try {
    db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`);
  } catch (e) {
    // column already exists
  }
}

const insertStmt = db.prepare(`
  INSERT INTO job_postings (source, source_platform, company, title, location, description, url, domain_priority,
    remote_policy, visa_sponsorship, relocation_offered, apply_type, dedup_hash, posted_at, last_seen_at, source_present)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(dedup_hash) DO UPDATE SET
    last_seen_at = CURRENT_TIMESTAMP,
    source_present = 1,
    posted_at = COALESCE(excluded.posted_at, posted_at),
    apply_type = excluded.apply_type
`);

const HOURS = parseInt(process.env.JOBSPY_HOURS || '168', 10) || 168;
const WANTED = parseInt(process.env.JOBSPY_WANTED || '25', 10) || 25;
const SITES = (process.env.JOBSPY_SITES || 'linkedin').split(',').map((s) => s.trim()).filter(Boolean);
const LOCATIONS = (process.env.JOBSPY_LOCATIONS || 'India,Remote').split(',').map((s) => s.trim()).filter(Boolean);
// Bound the query matrix. Roles x sites x locations grows fast and LinkedIn rate-limits around
// page 10, so cap the number of roles used rather than firing one query per suggested role.
const MAX_ROLES = parseInt(process.env.JOBSPY_MAX_ROLES || '4', 10) || 4;

const DEFAULT_ROLES = ['Healthcare Integration Architect', 'Solution Architect', 'Cloud Architect'];

async function main() {
  const roles = (getEnabledRoles(db).length ? getEnabledRoles(db) : DEFAULT_ROLES).slice(0, MAX_ROLES);
  console.log(`Ingesting via ts-jobspy (${SITES.join('+')}), last ${HOURS}h...`);
  console.log(`  roles: ${roles.join(', ')}`);
  console.log(`  locations: ${LOCATIONS.join(', ')}`);
  markSourceAbsent(db, SOURCE);

  let added = 0;
  let scanned = 0;
  let skippedIrrelevant = 0;
  let queries = 0;

  for (const site of SITES) {
    const isLinkedIn = site.toLowerCase() === 'linkedin';
    for (const role of roles) {
      for (const location of LOCATIONS) {
        queries++;
        try {
          const jobs = await scrapeJobs({
            siteName: site as never,
            searchTerm: role,
            location,
            resultsWanted: WANTED,
            hoursOld: HOURS,
            easyApply: isLinkedIn ? true : undefined,
            countryIndeed: 'india',
            linkedinFetchDescription: true,
            verbose: 0,
          });
          let localAdded = 0;
          for (const j of jobs) {
            scanned++;
            const title = (j.title || '').trim();
            const company = (j.company || '').trim() || 'Unknown';
            const description = (j.description || '').trim();
            const url = j.jobUrlDirect || j.jobUrl || '';
            if (!title || !url) continue;

            // Breadth gate, same as the other broad sources: healthcare-IT always passes, and
            // non-healthcare roles only if they're senior/technical. Keeps the "explore all jobs,
            // healthcare-first" behaviour rather than hard-filtering by domain.
            const domainPri = isDomainPriority(`${title} ${description}`);
            if (!domainPri && !isSeniorRelevant(title)) {
              skippedIrrelevant++;
              continue;
            }

            const loc = (j.location || location || '').trim();
            const cls = classifyJob(title, description, loc);
            const hash = createHash('sha256').update(SOURCE + company + title + loc).digest('hex');
            // The whole point of this source: a real posting date, from the source.
            const postedAt = j.datePosted || null;
            const applyType = isLinkedIn ? 'easy_apply' : 'unknown';

            const res = insertStmt.run(
              SOURCE, site.toLowerCase(), company, title, loc, description.slice(0, 8000), url,
              domainPri ? 1 : 0, cls.remote_policy, cls.visa_sponsorship, cls.relocation_offered,
              applyType, hash, postedAt,
            );
            if (res.changes > 0) localAdded++;
          }
          added += localAdded;
          console.log(`  ✓ ${site} "${role}" @ ${location}: ${jobs.length} returned, ${localAdded} added/updated`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`  ✗ ${site} "${role}" @ ${location}: ${msg.slice(0, 110)}`);
        }
      }
    }
  }

  const withDates = (db.prepare(
    `SELECT COUNT(*) n FROM job_postings WHERE source = ? AND posted_at IS NOT NULL`,
  ).get(SOURCE) as { n: number }).n;
  const totalRows = (db.prepare('SELECT COUNT(*) n FROM job_postings WHERE source = ?').get(SOURCE) as { n: number }).n;
  console.log(`ts-jobspy complete: ${added} added/updated from ${scanned} scanned across ${queries} queries`);
  console.log(`  (${skippedIrrelevant} skipped by the seniority/domain gate)`);
  console.log(`  ${SOURCE} rows in DB: ${totalRows}, of which ${withDates} have a posting date`);
  db.close();
}

main().catch((e) => {
  console.error('ts-jobspy error:', e);
  db.close();
  process.exitCode = 1;
});
