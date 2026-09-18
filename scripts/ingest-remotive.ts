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
  'CMS', 'ONC', 'HIPAA', 'USCDI', 'TEFCA', 'Prior Auth',
  'interoperability', 'HITECH', 'PHI', 'CCDA', 'C-CDA',
  'Mirth Connect', 'Azure Health Data Services',
  'AWS HealthLake', 'DICOM', 'IHE', 'SNOMED', 'LOINC', 'ICD-10', 'RxNorm',
];

const PROFILE_KEYWORDS = [
  'healthcare', 'health tech', 'healthtech', 'clinical', 'medical',
  'solution architect', 'integration', 'interoperability', 'data engineer',
  'full stack', 'node.js', 'typescript', 'react', 'angular', 'azure',
  'kubernetes', 'microservices', 'api', 'cloud', 'devops',
  'hl7', 'fhir', 'ehr', 'emr', 'payer', 'backend', 'software engineer',
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

// Remotive has categories - fetch software-dev and others
const CATEGORIES = ['software-dev', 'devops-sysadmin', 'data', 'all-others'];

async function fetchCategory(category: string) {
  const url = `https://remotive.com/api/remote-jobs?category=${category}&limit=100`;
  const res = await fetch(url);

  if (!res.ok) {
    console.log(`  ✗ Remotive ${category}: HTTP ${res.status}`);
    return 0;
  }

  const data = await res.json();
  const jobs = data.jobs || [];
  let added = 0;

  for (const job of jobs) {
    const title = job.title || '';
    const company = job.company_name || '';
    const location = job.candidate_required_location || 'Remote';
    const description = (job.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const jobUrl = job.url || '';
    const tags = (job.tags || []).join(' ');

    const fullText = `${title} ${company} ${description} ${tags}`;

    if (!isRelevantJob(fullText)) continue;

    const hash = createHash('sha256')
      .update('remotive' + company + title)
      .digest('hex');

    const dp = isDomainPriority(fullText) ? 1 : 0;
    const postedAt = job.publication_date || null;

    const result = insertStmt.run('remotive', company, title, location, description.slice(0, 10000), jobUrl, dp, hash, postedAt);
    if (result.changes > 0) added++;
  }

  return added;
}

async function main() {
  console.log('Ingesting from Remotive...');
  markSourceAbsent(db, 'remotive');

  let totalAdded = 0;
  for (const category of CATEGORIES) {
    const added = await fetchCategory(category);
    console.log(`  ✓ ${category}: ${added} relevant jobs`);
    totalAdded += added;
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`  ✓ Remotive total: ${totalAdded} jobs added`);
  db.close();
}

main().catch((err) => { console.error('Remotive error:', err.message); db.close(); });
