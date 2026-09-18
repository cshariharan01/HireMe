import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';

const ALL_TERMS = [
  'FHIR R4', 'FHIR STU3', 'FHIR R5', 'HL7', 'HL7 v2', 'HL7 CDA',
  'SMART on FHIR', 'CDS Hooks', 'Bulk FHIR', 'FHIR API', 'HL7 FHIR',
  'Epic', 'Cerner', 'Oracle Health', 'Meditech', 'Allscripts',
  'Epic App Orchard', 'athenahealth', 'Cerner Millennium', 'Epic Bridges',
  'Epic Caboodle', 'eClinicalWorks', 'NextGen',
  'CMS', 'ONC', 'HIPAA', 'USCDI', 'TEFCA', 'Prior Auth',
  '21st Century Cures', 'interoperability', 'HITECH', 'PHI', 'CCDA', 'C-CDA',
  'Mirth Connect', 'Azure Health Data Services',
  'AWS HealthLake', 'DICOM', 'IHE', 'SNOMED', 'LOINC', 'ICD-10', 'RxNorm',
];

// Additional keywords relevant to user's profile
const PROFILE_KEYWORDS = [
  'healthcare', 'health tech', 'healthtech', 'clinical', 'medical',
  'solution architect', 'integration', 'interoperability', 'data engineer',
  'full stack', 'node.js', 'typescript', 'react', 'angular', 'azure',
  'kubernetes', 'microservices', 'api', 'cloud', 'devops',
  'hl7', 'fhir', 'ehr', 'emr', 'payer',
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

function isRelevantJob(text: string): boolean {
  const lower = text.toLowerCase();
  let matches = 0;
  for (const kw of PROFILE_KEYWORDS) {
    if (lower.includes(kw)) {
      matches++;
      if (matches >= 2) return true;
    }
  }
  return false;
}

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
    source TEXT, company TEXT, title TEXT, location TEXT,
    description TEXT, url TEXT, embedding BLOB,
    domain_priority INTEGER DEFAULT 0, dedup_hash TEXT UNIQUE,
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
ensureFreshnessColumns(db);

const insertStmt = db.prepare(`
  INSERT INTO job_postings (source, company, title, location, description, url, domain_priority, dedup_hash, posted_at, last_seen_at, source_present)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(dedup_hash) DO UPDATE SET
    last_seen_at = CURRENT_TIMESTAMP,
    source_present = 1,
    posted_at = COALESCE(excluded.posted_at, posted_at)
`);

async function main() {
  console.log('Ingesting from RemoteOK...');
  markSourceAbsent(db, 'remoteok');

  const res = await fetch('https://remoteok.com/api', {
    headers: { 'User-Agent': 'HireSignal/1.0' },
  });

  if (!res.ok) {
    console.log(`  ✗ RemoteOK API error: ${res.status}`);
    db.close();
    return;
  }

  const data = await res.json();
  // First element is metadata, skip it
  const jobs = Array.isArray(data) ? data.slice(1) : [];

  console.log(`  Found ${jobs.length} total jobs`);

  let added = 0;
  for (const job of jobs) {
    const title = job.position || '';
    const company = job.company || '';
    const location = job.location || 'Remote';
    const description = (job.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const url = job.url || '';
    const tags = (job.tags || []).join(' ');

    const fullText = `${title} ${company} ${description} ${tags}`;

    // Filter: only keep jobs relevant to the user's profile
    if (!isRelevantJob(fullText)) continue;

    const hash = createHash('sha256')
      .update('remoteok' + company + title)
      .digest('hex');

    const dp = isDomainPriority(fullText) ? 1 : 0;
    const postedAt = job.date || null;

    const result = insertStmt.run('remoteok', company, title, location, description.slice(0, 10000), url, dp, hash, postedAt);
    if (result.changes > 0) added++;
  }

  console.log(`  ✓ RemoteOK: ${added} relevant jobs added`);
  db.close();
}

main().catch((err) => { console.error('RemoteOK error:', err.message); db.close(); });
