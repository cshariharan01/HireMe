import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';
import { isSeniorRelevant } from '../src/lib/seniority';
import { resolveAllowJunior } from './shared/profile-level';

// Ontology (duplicated — see CLAUDE.md for why)
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

// Himalayas provides locationRestrictions as a structured array — use it directly
// and augment with description-based keyword scan.
function classifyHimalayas(title: string, description: string, location: string, locationRestrictions: string[]): { remote_policy: string; visa_sponsorship: number; relocation_offered: number } {
  const haystack = `${title}\n${location}\n${description}`;

  let remote_policy: string;
  if (locationRestrictions.length === 0) {
    // No restrictions = truly global remote
    remote_policy = 'global';
  } else {
    const hasIndia = locationRestrictions.some((r) => /india|worldwide|anywhere|global/i.test(r));
    const hasUS = locationRestrictions.some((r) => /united states|^us$|^usa$/i.test(r));
    if (hasIndia) remote_policy = 'global';
    else if (hasUS && locationRestrictions.length <= 2) remote_policy = 'us-only';
    else if (GLOBAL_REMOTE_RE.test(haystack)) remote_policy = 'global';
    else if (US_ONLY_RE.test(haystack)) remote_policy = 'us-only';
    else if (COUNTRY_RE.test(haystack)) remote_policy = 'country-specific';
    else remote_policy = 'country-specific'; // restricted but not US-only — e.g., UK, Germany
  }

  return {
    remote_policy,
    visa_sponsorship: hasUnnegated(haystack, VISA_RE) ? 1 : 0,
    relocation_offered: hasUnnegated(haystack, RELOCATION_RE) ? 1 : 0,
  };
}

function stripHtml(html: string): string {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hiresignal.db'));
const allowJunior = resolveAllowJunior(db); // experience-aware: keep junior roles for early-career resumes
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
    source TEXT, company TEXT, title TEXT, location TEXT,
    description TEXT, url TEXT, embedding BLOB,
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

interface HimalayasJob {
  title: string;
  companyName: string;
  locationRestrictions: string[];
  description: string;
  applicationLink: string;
  categories: string[];
}

async function main() {
  console.log('Ingesting from Himalayas...');
  markSourceAbsent(db, 'himalayas');
  // API caps at 20/page regardless of requested limit; paginate.
  const PAGE = 20;
  const MAX_SCAN = 3000;
  let offset = 0;
  let totalAdded = 0;
  let totalScanned = 0;
  let consecutiveEmpty = 0;

  while (totalScanned < MAX_SCAN) {
    const res = await fetch(`https://himalayas.app/jobs/api?limit=${PAGE}&offset=${offset}`);
    if (!res.ok) {
      console.log(`  ✗ HTTP ${res.status}, stopping`);
      break;
    }

    const data = await res.json();
    const jobs: HimalayasJob[] = data.jobs || [];
    if (jobs.length === 0) break;

    let batchAdded = 0;
    for (const job of jobs) {
      totalScanned++;
      const title = job.title || '';
      const company = job.companyName || '';
      const location = (job.locationRestrictions || []).join(', ') || 'Remote';
      const description = stripHtml(job.description || '');
      const url = job.applicationLink || '';

      const domainPri = isDomainPriority(title + ' ' + description);
      // Keep healthcare-IT (domain) OR senior technical/architect roles across any industry;
      // drop junior/sales/non-eng noise. Category alone is too loose (e.g. "all-other").
      if (!domainPri && !isSeniorRelevant(title, { allowJunior })) continue;

      const hash = createHash('sha256')
        .update('himalayas' + company + title + location)
        .digest('hex');

      const cls = classifyHimalayas(title, description, location, job.locationRestrictions || []);
      const postedAt = null;

      const result = insertStmt.run(
        'himalayas', company, title, location, description, url,
        domainPri ? 1 : 0, cls.remote_policy, cls.visa_sponsorship, cls.relocation_offered,
        hash, postedAt
      );
      if (result.changes > 0) batchAdded++;
    }
    totalAdded += batchAdded;
    if (batchAdded === 0) consecutiveEmpty++;
    else consecutiveEmpty = 0;

    if (offset % 200 === 0) console.log(`  offset=${offset}: scanned=${jobs.length}, added=${batchAdded} (total added=${totalAdded}/${totalScanned})`);

    // If we've seen 10 consecutive empty batches, likely drifted out of relevant categories
    if (consecutiveEmpty >= 10) {
      console.log(`  Stopping early — 10 consecutive empty batches (drifted out of relevant space)`);
      break;
    }

    offset += PAGE;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`Himalayas ingestion complete. Added ${totalAdded} relevant jobs (scanned ${totalScanned}).`);
  db.close();
}

main().catch((err) => { console.error('Himalayas error:', err.message); db.close(); });
