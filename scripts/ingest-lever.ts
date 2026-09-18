import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';

const FHIR_TERMS = [
  'FHIR R4', 'FHIR STU3', 'FHIR R5', 'HL7', 'HL7 v2', 'HL7 CDA',
  'SMART on FHIR', 'CDS Hooks', 'Bulk FHIR', 'FHIR API', 'HL7 FHIR',
];
const EHR_TERMS = [
  'Epic', 'Cerner', 'Oracle Health', 'Meditech', 'Allscripts',
  'Epic App Orchard', 'athenahealth', 'Cerner Millennium', 'Epic Bridges',
  'Epic Caboodle', 'eClinicalWorks', 'NextGen',
];
const REGULATORY_TERMS = [
  'CMS', 'ONC', 'HIPAA', 'USCDI', 'TEFCA', 'Prior Auth',
  '21st Century Cures', 'interoperability', 'HITECH', 'PHI', 'CCDA', 'C-CDA',
];
const INTEGRATION_TERMS = [
  'Mirth Connect', 'Azure Health Data Services',
  'AWS HealthLake', 'DICOM', 'IHE', 'SNOMED', 'LOINC', 'ICD-10', 'RxNorm',
];
const ALL_TERMS = [...FHIR_TERMS, ...EHR_TERMS, ...REGULATORY_TERMS, ...INTEGRATION_TERMS];

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
    const before = haystack.slice(Math.max(0, m.index - 80), m.index);
    const after = haystack.slice(m.index + m[0].length, Math.min(haystack.length, m.index + m[0].length + 60));
    if (NEGATION_RE.test(before) || NEGATION_RE.test(after)) continue;
    return true;
  }
  return false;
}

function classifyJob(title: string, description: string, location: string): { remote_policy: string; visa_sponsorship: number; relocation_offered: number } {
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

// Verified live Lever slugs (probed 2026-04-26). 60-slug audit yielded only these two
// for healthcare-IT. The rest of the famous names use Greenhouse, Workday, or in-house ATS.
const HEALTHCARE_IT_COMPANIES = [
  'arcadia',     // 15 jobs — population health platform
  'redoxengine', // 13 jobs — interoperability APIs (priority)
];

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hiresignal.db'));
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
// Per-connection: the NORMAL set in src/lib/db.ts does not reach a standalone script, and
// better-sqlite3 defaults to FULL — one fsync per autocommit write.
db.pragma('synchronous = NORMAL');
// REQUIRED once ingest sources run concurrently: WAL allows one writer at a time, and without
// a busy timeout a second writer fails immediately with SQLITE_BUSY instead of waiting its turn.
db.pragma('busy_timeout = 15000');

db.exec(`
  CREATE TABLE IF NOT EXISTS job_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    company TEXT,
    title TEXT,
    location TEXT,
    description TEXT,
    url TEXT,
    embedding BLOB,
    domain_priority INTEGER DEFAULT 0,
    remote_policy TEXT,
    visa_sponsorship INTEGER DEFAULT 0,
    relocation_offered INTEGER DEFAULT 0,
    dedup_hash TEXT UNIQUE,
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
for (const spec of ['remote_policy TEXT', 'visa_sponsorship INTEGER DEFAULT 0', 'relocation_offered INTEGER DEFAULT 0']) {
  try { db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`); }
  catch (e) { if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e; }
}
ensureFreshnessColumns(db);

const insertStmt = db.prepare(`
  INSERT INTO job_postings (source, company, title, location, description, url, domain_priority, remote_policy, visa_sponsorship, relocation_offered, dedup_hash, posted_at, last_seen_at, source_present)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(dedup_hash) DO UPDATE SET
    last_seen_at = CURRENT_TIMESTAMP,
    source_present = 1,
    posted_at = COALESCE(excluded.posted_at, posted_at)
`);

async function ingestCompany(company: string) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${company}?mode=json`);
    if (!res.ok) {
      console.log(`  ✗ ${company}: HTTP ${res.status}`);
      return;
    }

    const jobs = await res.json();
    if (!Array.isArray(jobs)) {
      console.log(`  ✗ ${company}: unexpected response`);
      return;
    }

    let added = 0;
    for (const job of jobs) {
      const title = job.text || '';
      const location = job.categories?.location || '';
      const description = job.descriptionPlain || '';
      const url = job.hostedUrl || '';

      const hash = createHash('sha256')
        .update(company + title + location)
        .digest('hex');

      const dp = isDomainPriority(title + ' ' + description) ? 1 : 0;
      const cls = classifyJob(title, description, location);
      const postedAt = job.createdAt ? new Date(job.createdAt).toISOString() : null;

      const result = insertStmt.run('lever', company, title, location, description, url, dp, cls.remote_policy, cls.visa_sponsorship, cls.relocation_offered, hash, postedAt);
      if (result.changes > 0) added++;
    }

    console.log(`  ✓ ${company}: ${added} jobs added`);
  } catch (err) {
    console.log(`  ✗ ${company}: ${(err as Error).message}`);
  }
}

async function main() {
  console.log('Ingesting from Lever...');
  markSourceAbsent(db, 'lever');
  for (const company of HEALTHCARE_IT_COMPANIES) {
    await ingestCompany(company);
    await new Promise((r) => setTimeout(r, 10000));
  }
  console.log('Lever ingestion complete.');
  db.close();
}

main();
