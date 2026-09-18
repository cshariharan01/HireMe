// 4 Day Week ingest — JSON API. Listing endpoint lacks descriptions, so we fetch each
// job's detail page when its title looks senior-tech enough to be relevant.
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';
import { isSeniorRelevant } from '../src/lib/seniority';
import { resolveAllowJunior } from './shared/profile-level';

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

const VISA_RE = /(visa sponsorship|we sponsor|sponsor(?:ing)? visas?|h-?1b|will sponsor)/gi;
const RELOCATION_RE = /(relocation (?:assistance|package|support|help|bonus|benefits?)|relocation offered|will relocate)/gi;
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

interface RemoteAllowed { country: string; continent: string; is_primary: boolean }
interface FourDWJob {
  id: string;
  title: string;
  slug: string;
  company_name: string;
  work_arrangement: string;
  remote_allowed?: RemoteAllowed[];
  category?: string;
  level?: string;
  schedule_type?: string;
  is_expired: boolean;
}

interface FourDWDetail extends FourDWJob {
  description?: string;
  description_html?: string;
}

function classify4DW(allowed: RemoteAllowed[] | undefined, title: string, description: string): { remote_policy: string; visa_sponsorship: number; relocation_offered: number } {
  const haystack = `${title}\n${description}`;
  let remote_policy: string;
  if (!allowed || allowed.length === 0) {
    remote_policy = 'global';
  } else {
    const hasIndia = allowed.some((r) => /india/i.test(r.country) || /asia/i.test(r.continent));
    const hasUS = allowed.some((r) => /united states|^us$|^usa$/i.test(r.country));
    if (hasIndia) remote_policy = 'global';
    else if (hasUS && allowed.length <= 2) remote_policy = 'us-only';
    else remote_policy = 'country-specific';
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

async function fetchJobDetail(slug: string): Promise<string> {
  try {
    const res = await fetch(`https://4dayweek.io/api/jobs/${slug}`);
    if (!res.ok) return '';
    const data = (await res.json()) as FourDWDetail;
    return stripHtml(data.description_html || data.description || '');
  } catch {
    return '';
  }
}

async function main() {
  console.log('Ingesting from 4 Day Week...');
  markSourceAbsent(db, '4dayweek');
  const PAGE = 50;
  const MAX_SCAN = 600;
  let offset = 0;
  let totalAdded = 0;
  let totalScanned = 0;

  while (totalScanned < MAX_SCAN) {
    const res = await fetch(`https://4dayweek.io/api/jobs?limit=${PAGE}&offset=${offset}`);
    if (!res.ok) {
      console.log(`  ✗ HTTP ${res.status}`);
      break;
    }
    const data = await res.json();
    const jobs: FourDWJob[] = data.jobs || [];
    if (jobs.length === 0) break;

    for (const job of jobs) {
      totalScanned++;
      if (job.is_expired) continue;
      const title = job.title || '';
      // Filter to senior tech/architect roles before fetching detail (shared gate).
      if (!isSeniorRelevant(title, { allowJunior })) continue;

      const company = job.company_name || 'Unknown';
      const location = (job.remote_allowed || []).map((r) => r.country).join(', ') || 'Remote';
      const url = `https://4dayweek.io/jobs/${job.slug}`;

      const description = await fetchJobDetail(job.slug);
      await new Promise((r) => setTimeout(r, 600)); // polite

      const dp = isDomainPriority(title + ' ' + description);
      const cls = classify4DW(job.remote_allowed, title, description);

      const hash = createHash('sha256').update('4dw' + company + title + location).digest('hex');
      const postedAt = null;
      const result = insertStmt.run(
        '4dayweek', company, title, location, description, url,
        dp ? 1 : 0, cls.remote_policy, cls.visa_sponsorship, cls.relocation_offered, hash, postedAt
      );
      if (result.changes > 0) totalAdded++;
    }

    if (offset % 100 === 0) console.log(`  offset=${offset}: total added ${totalAdded}/${totalScanned}`);
    if (jobs.length < PAGE) break;
    offset += PAGE;
  }

  console.log(`4 Day Week complete. ${totalAdded} new jobs (scanned ${totalScanned}).`);
  db.close();
}

main().catch((err) => { console.error('4DayWeek error:', err.message); db.close(); });
