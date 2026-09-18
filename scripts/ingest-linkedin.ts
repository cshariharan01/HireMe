// LinkedIn jobs ingest via the public guest-search endpoint (no login).
// Hits https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search which
// returns a server-rendered HTML fragment with ~25 cards per request.
//
// CAVEATS — read this before relying on it:
//  - LinkedIn rate-limits aggressively. ~50-100 detail fetches per hour usually OK.
//    Beyond that you'll hit a 429 or HTML challenge page.
//  - Selectors break when LinkedIn updates their templates. Expect to fix this script
//    every few months.
//  - This script ONLY hits public guest URLs. No login. No cookies. No automation
//    against authenticated pages. Still nominally a ToS violation; appropriate for
//    personal use, never for commercial scraping.
//  - SEARCH_QUERIES is the configuration knob — tune it to your actual roles.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';
import { getEnabledRoles, getProfileYoe, resolveSearchRoles } from './shared/profile-roles';
import { isSeniorityCompatible, isExperienceCompatible } from '../src/lib/target-job-filter';

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

const GLOBAL_REMOTE_RE = /\b(work from anywhere|remote worldwide|remote \(global\)|open to international|globally remote|anywhere in the world)\b/i;
const US_ONLY_RE = /\b(us(?:a)? only|u\.s\.? only|must be (?:a )?us (?:citizen|resident)|requires us work authorization|us residents only)\b/i;
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

function classifyJob(title: string, description: string, location: string): {
  remote_policy: string;
  visa_sponsorship: number;
  relocation_offered: number;
} {
  const haystack = `${title} ${description} ${location}`;
  const loc = (location || '').toLowerCase();
  let remote_policy: string;
  if (/remote|work from home|wfh/i.test(location || '')) remote_policy = 'remote';
  else if (loc.includes('india') || loc.includes('bengaluru') || loc.includes('bangalore') || loc.includes('hyderabad') || loc.includes('chennai') || loc.includes('pune') || loc.includes('noida') || loc.includes('delhi') || loc.includes('mumbai') || loc.includes('gurgaon')) remote_policy = 'india-friendly';
  else if (loc.includes('united states') || /,\s*[A-Z]{2}\b/.test(location || '')) remote_policy = 'us-only';
  else remote_policy = 'unknown';
  return {
    remote_policy,
    visa_sponsorship: hasUnnegated(haystack, VISA_RE) ? 1 : 0,
    relocation_offered: hasUnnegated(haystack, RELOCATION_RE) ? 1 : 0,
  };
}

// Configure the searches you actually care about. Each runs once, scrapes 1 page (~25 jobs).
type SearchQuery = { keywords: string; location: string; geoId?: string };
const DEFAULT_QUERIES: SearchQuery[] = [
  { keywords: 'Data Engineer', location: 'India' },
  { keywords: 'Data Engineer', location: 'Remote' },
  { keywords: 'Cloud Data Engineer', location: 'India' },
  { keywords: 'PySpark Data Engineer', location: 'India' },
  { keywords: 'ETL Developer', location: 'India' },
  { keywords: 'Big Data Engineer', location: 'India' },
];

// Build LinkedIn queries from the user's target roles from their profile.
// Falls back to DEFAULT_QUERIES when no roles are set in the profile.
function buildQueries(db: Database.Database): SearchQuery[] {
  const roles = resolveSearchRoles(db, DEFAULT_QUERIES.map((q) => q.keywords));
  const out: SearchQuery[] = [];
  for (const role of roles) {
    out.push({ keywords: role, location: 'India' });
    out.push({ keywords: role, location: 'Remote' });
  }
  return out;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchSearchPage(keywords: string, location: string, start = 0, postedAtMap?: Map<string, string>): Promise<string[]> {
  // LinkedIn's native f_AL filter restricts search results to Easy Apply jobs before we
  // fetch individual job details. Keep the runtime apply preflight as a fallback because
  // LinkedIn can change or ignore undocumented guest-search parameters.
  const params = new URLSearchParams({
    keywords,
    location,
    start: String(start),
    f_AL: 'true',
    sortBy: 'DD',
    f_TPR: 'r86400', // Past 24 hours only
  });
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    console.log(`  ✗ search "${keywords}" @ ${location}: HTTP ${res.status}`);
    return [];
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  const ids = new Set<string>();

  // Read cards directly to skip high seniority roles early before fetching details
  $('li').each((_, el) => {
    const $el = $(el);
    const title =
      $el.find('h3.base-search-card__title').text().trim() ||
      $el.find('.base-search-card__title').text().trim();
    if (title && !isSeniorityCompatible(title)) {
      return;
    }
    const timeEl = $el.find('time');
    const dateStr = timeEl.attr('datetime') || timeEl.text().trim() || '';

    const urn = $el.find('[data-entity-urn]').attr('data-entity-urn') || $el.attr('data-entity-urn') || '';
    const m = urn.match(/jobPosting:(\d+)/);
    if (m) {
      ids.add(m[1]);
      if (dateStr && postedAtMap) postedAtMap.set(m[1], dateStr);
      return;
    }
    const href = $el.find('a.base-card__full-link, a.base-card__full-link-title').attr('href') || '';
    const hm = href.match(/\/jobs\/view\/[^/?]*?-?(\d+)(?:\?|\/|$)/);
    if (hm) {
      ids.add(hm[1]);
      if (dateStr && postedAtMap) postedAtMap.set(hm[1], dateStr);
    }
  });

  // Fallback to any entity-urns
  $('[data-entity-urn]').each((_, el) => {
    const urn = $(el).attr('data-entity-urn') || '';
    const m = urn.match(/jobPosting:(\d+)/);
    if (m) ids.add(m[1]);
  });

  return Array.from(ids);
}

interface JobDetail {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
}

async function fetchJobDetail(id: string): Promise<JobDetail | null> {
  const url = `https://www.linkedin.com/jobs/view/${id}/`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const html = await res.text();
  const $ = cheerio.load(html);

  // Title
  const title =
    $('h1.top-card-layout__title').first().text().trim() ||
    $('h1.topcard__title').first().text().trim() ||
    $('h1').first().text().trim();

  // Company
  const company =
    $('a.topcard__org-name-link').first().text().trim() ||
    $('.topcard__flavor a').first().text().trim() ||
    $('.top-card-layout__company-url').first().text().trim() ||
    'Unknown';

  // Location
  const location =
    $('.topcard__flavor--bullet').first().text().trim() ||
    $('.top-card-layout__second-subline span').first().text().trim() ||
    '';

  // Description (the public view dumps it as HTML in this container)
  const description =
    $('.show-more-less-html__markup').text().trim() ||
    $('.description__text').text().trim() ||
    $('section.show-more-less-html').text().trim();

  if (!title || !description) return null;
  return { id, title, company, location, description, url };
}

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'hiresignal.db'));
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
// Per-connection, so the NORMAL set in src/lib/db.ts does not apply to this script. better-sqlite3
// defaults to FULL, i.e. one fsync per autocommit write.
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
  try {
    db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`);
  } catch (e) {
    if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
  }
}
ensureFreshnessColumns(db);

// The single biggest cost in this script was re-fetching job details we already have. LinkedIn's
// detail URL is deterministic (https://www.linkedin.com/jobs/view/<id>/), so a row's presence can
// be checked from the id ALONE, before spending a 6-second fetch on it. Measured impact: with ~250
// unique ids and 256 LinkedIn rows already in SQLite, this removes 10-25 minutes per run.
// (Copies the pattern ingest-hirist.ts already uses.)
const checkExistsStmt = db.prepare(
  "SELECT id FROM job_postings WHERE source = 'linkedin' AND url LIKE ? LIMIT 1",
);
const touchStmt = db.prepare(
  "UPDATE job_postings SET last_seen_at = CURRENT_TIMESTAMP, source_present = 1 WHERE source = 'linkedin' AND url LIKE ?",
);

const insertStmt = db.prepare(`
  INSERT INTO job_postings (source, source_platform, company, title, location, description, url, domain_priority, remote_policy, visa_sponsorship, relocation_offered, apply_type, dedup_hash, posted_at, last_seen_at, source_present)
  VALUES (?, 'linkedin', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'easy_apply', ?, ?, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(dedup_hash) DO UPDATE SET
    last_seen_at = CURRENT_TIMESTAMP,
    source_present = 1,
    posted_at = COALESCE(excluded.posted_at, posted_at)
`);

async function main() {
  console.log('Ingesting from LinkedIn (jobs-guest endpoint)...');
  markSourceAbsent(db, 'linkedin');
  const SEARCH_QUERIES = buildQueries(db);
  console.log(`  ${SEARCH_QUERIES.length} queries (${SEARCH_QUERIES.map((q) => q.keywords).join(', ')})`);

  const allIds = new Set<string>();
  const postedAtMap = new Map<string, string>();
  for (const q of SEARCH_QUERIES) {
    for (const start of [0]) {
      try {
        const ids = await fetchSearchPage(q.keywords, q.location, start, postedAtMap);
        console.log(`  ✓ "${q.keywords}" @ ${q.location}: ${ids.length} 24h ids`);
        ids.forEach((id) => allIds.add(id));
        await sleep(1500); // 1.5 sec between searches
      } catch (e) {
        console.log(`  ✗ search error: ${(e as Error).message}`);
        await sleep(5000); // back off
      }
    }
  }

  console.log(`Found ${allIds.size} unique job IDs. Fetching details (~2.5s each)...`);
  let added = 0;
  let failed = 0;
  let count = 0;
  let skipped = 0;
  const MAX_NEW_DETAILS = 50; // Bound new fetches per sync so runs complete promptly
  for (const id of Array.from(allIds)) {
    if (added >= MAX_NEW_DETAILS) {
      console.log(`  · reached batch limit of ${MAX_NEW_DETAILS} newly added jobs for this sync`);
      break;
    }
    count++;
    // Already have it? Refresh freshness and move on — no HTTP, no sleep.
    const urlPattern = `%/jobs/view/${id}%`;
    if (checkExistsStmt.get(urlPattern)) {
      touchStmt.run(urlPattern);
      skipped++;
      continue;
    }
    try {
      const detail = await fetchJobDetail(id);
      if (!detail) {
        failed++;
        await sleep(2500);
        continue;
      }

      if (!isSeniorityCompatible(detail.title)) {
        console.log(`  · skip high seniority (${detail.title})`);
        continue;
      }

      if (!isExperienceCompatible(null, null, `${detail.title} ${detail.description}`)) {
        console.log(`  · skip incompatible experience (${detail.title})`);
        continue;
      }

      const dp = isDomainPriority(detail.title + ' ' + detail.description);
      const cls = classifyJob(detail.title, detail.description, detail.location);
      const hash = createHash('sha256')
        .update('linkedin' + detail.company + detail.title + detail.location)
        .digest('hex');
      const result = insertStmt.run(
        'linkedin',
        detail.company,
        detail.title,
        detail.location,
        detail.description.slice(0, 8000),
        detail.url,
        dp ? 1 : 0,
        cls.remote_policy,
        cls.visa_sponsorship,
        cls.relocation_offered,
        hash,
        postedAtMap.get(id) || null
      );
      if (result.changes > 0) added++;
      if (count % 5 === 0) console.log(`  progress: ${count}/${allIds.size} (added=${added}, failed=${failed})`);
      await sleep(2500); // 2.5 sec between detail fetches
    } catch (e) {
      failed++;
      console.log(`  ✗ ${id}: ${(e as Error).message}`);
      await sleep(8000); // back off harder on errors
    }
  }

  console.log(`LinkedIn complete. Added ${added}, skipped ${skipped} already-known, failed ${failed} of ${allIds.size}.`);
  if (skipped > 0) {
    console.log(`  (skipping ${skipped} known ids saved roughly ${Math.round((skipped * 6) / 60)} min of detail fetches)`);
  }
  if (failed > allIds.size / 2) {
    console.log('  ⚠ More than half failed — LinkedIn may be challenging your IP. Wait a few hours.');
  }
  db.close();
}

main().catch((err) => {
  console.error('LinkedIn error:', err.message);
  db.close();
});
