// We Work Remotely RSS ingest. WWR has multiple category feeds; we hit the relevant ones.
// Pattern: <item> with title "Company: Job Title", region, category, description (HTML).
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent, normalizePostedAt } from './shared/freshness';
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

const VISA_RE = /(visa sponsorship|we sponsor|sponsor(?:ing)? visas?|h-?1b|green card sponsor|will sponsor)/gi;
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
const US_ONLY_RE = /\b(us(?:a)? only|u\.s\.? only|must be (?:a )?us (?:citizen|resident)|requires us work authorization|us residents only|usa residents only)\b/i;

function classifyWWR(title: string, description: string, region: string): { remote_policy: string; visa_sponsorship: number; relocation_offered: number } {
  const haystack = `${title}\n${region}\n${description}`;
  const hay = haystack.toLowerCase();
  const reg = region.toLowerCase();
  let remote_policy: string;
  if (/anywhere in the world|worldwide|global/i.test(reg)) remote_policy = 'global';
  else if (US_ONLY_RE.test(haystack) || /(usa only|us-only)/i.test(reg)) remote_policy = 'us-only';
  else if (/^(india|uk|canada|germany|netherlands|australia|eu|europe|americas)/i.test(reg.trim())) remote_policy = 'country-specific';
  else if (hay.includes('us-only') || hay.includes('us only')) remote_policy = 'us-only';
  else remote_policy = 'unknown';
  return {
    remote_policy,
    visa_sponsorship: hasUnnegated(haystack, VISA_RE) ? 1 : 0,
    relocation_offered: hasUnnegated(haystack, RELOCATION_RE) ? 1 : 0,
  };
}

function stripHtml(html: string): string {
  return (html || '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
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

const FEEDS = [
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
  'https://weworkremotely.com/categories/all-other-remote-jobs.rss',
  'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
];

// Naive RSS item extractor — WWR feeds are well-formed enough for regex
function extractItems(xml: string): Array<{ title: string; region: string; category: string; description: string; link: string; pubDate: string }> {
  const items: Array<{ title: string; region: string; category: string; description: string; link: string; pubDate: string }> = [];
  const blocks = xml.split('<item>').slice(1);
  for (const b of blocks) {
    const end = b.indexOf('</item>');
    const inner = end >= 0 ? b.slice(0, end) : b;
    const get = (tag: string) => {
      const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
      const m = inner.match(re);
      return m ? m[1].trim() : '';
    };
    items.push({
      title: get('title'),
      region: get('region'),
      category: get('category'),
      description: get('description'),
      link: get('link') || get('guid'),
      pubDate: get('pubDate'),
    });
  }
  return items;
}

async function ingestFeed(url: string) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'HireSignal-Personal/1.0' } });
    if (!res.ok) {
      console.log(`  ✗ ${url}: HTTP ${res.status}`);
      return 0;
    }
    const xml = await res.text();
    const items = extractItems(xml);
    let added = 0;
    for (const item of items) {
      // WWR title format: "Company: Job Title"
      const splitIdx = item.title.indexOf(':');
      const company = splitIdx > 0 ? item.title.slice(0, splitIdx).trim() : 'Unknown';
      const title = splitIdx > 0 ? item.title.slice(splitIdx + 1).trim() : item.title.trim();
      const description = stripHtml(item.description);
      const location = item.region || 'Remote';

      // Filter: keep architect/senior/engineer/lead titles + healthcare-IT priority
      const dp = isDomainPriority(title + ' ' + description);
      if (!dp && !isSeniorRelevant(title, { allowJunior })) continue;

      const hash = createHash('sha256').update('wwr' + company + title + location).digest('hex');
      const cls = classifyWWR(title, description, location);
      // RSS emits RFC-2822 ("Mon, 13 May 2024 ..."), which breaks any text comparison on this
      // column — see normalizePostedAt. Store ISO-8601.
      const postedAt = normalizePostedAt(item.pubDate || null);
      const result = insertStmt.run(
        'wwr', company, title, location, description, item.link,
        dp ? 1 : 0, cls.remote_policy, cls.visa_sponsorship, cls.relocation_offered, hash, postedAt
      );
      if (result.changes > 0) added++;
    }
    console.log(`  ✓ ${url.split('/').pop()}: ${added}/${items.length}`);
    return added;
  } catch (err) {
    console.log(`  ✗ ${url}: ${(err as Error).message}`);
    return 0;
  }
}

async function main() {
  console.log('Ingesting from We Work Remotely...');
  markSourceAbsent(db, 'wwr');
  let total = 0;
  for (const feed of FEEDS) {
    total += await ingestFeed(feed);
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`We Work Remotely complete. ${total} new jobs.`);
  db.close();
}

main().catch((err) => { console.error('WWR error:', err.message); db.close(); });
