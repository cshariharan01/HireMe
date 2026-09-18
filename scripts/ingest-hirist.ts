// Hirist (hirist.tech) ingest via Playwright. Hirist is an India-only tech jobs portal
// with no aggressive bot detection — standard playwright works as long as we throttle.
//
// Flow:
//   1. For each search keyword, hit https://www.hirist.tech/k/<slug>-jobs and read the
//      list page. Each `.joblist-card-v2` exposes title / experience / location / link
//      via [data-testid="..."] attributes.
//   2. For each unseen card (dedup_hash miss), open the detail page and grab the JD
//      from `[data-testid="job-description-container"]`. ~3-second polite delay
//      between detail fetches.
//
// CAVEATS:
//   - List page only shows ~20-25 cards per query without scrolling. We don't paginate
//     — the same JDs surface across queries anyway (dedup catches it).
//   - Selectors may break when Hirist updates their MUI theme. Run the diagnostic at
//     scripts/diag-hirist-deep.ts to re-discover selectors.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { chromium, type Page } from 'playwright';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';
import { getEnabledRoles } from './shared/profile-roles';

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
const NEGATION_RE = /\b(no|not|never|won'?t|will not|do not|don'?t|cannot|can not|unable|ineligible|without|nor)\b/i;
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
const GLOBAL_REMOTE_RE = /\b(work from anywhere|remote worldwide|remote \(global\)|globally remote)\b/i;

function classifyJob(title: string, description: string, location: string): { remote_policy: string; visa_sponsorship: number; relocation_offered: number } {
  const haystack = `${title}\n${location}\n${description}`;
  const loc = (location || '').toLowerCase();
  let remote_policy: string;
  if (GLOBAL_REMOTE_RE.test(haystack) || /\b(work from anywhere|remote worldwide|globally remote)\b/i.test(haystack)) {
    remote_policy = 'global';
  } else if (/remote|work from home|wfh/i.test(loc) || /remote|work from home|wfh/i.test(title)) {
    remote_policy = 'remote';
  } else if (loc.includes('india') || /bengaluru|bangalore|mumbai|delhi|gurgaon|gurugram|noida|hyderabad|chennai|pune|kolkata|ahmedabad/i.test(loc)) {
    remote_policy = 'country-specific';
  } else {
    remote_policy = 'country-specific';
  }
  return {
    remote_policy,
    visa_sponsorship: hasUnnegated(haystack, VISA_RE) ? 1 : 0,
    relocation_offered: hasUnnegated(haystack, RELOCATION_RE) ? 1 : 0,
  };
}

// Mix of healthcare-IT specific + senior-architect generic. Hirist returns ~20-25 per slug.
// Override with HIRIST_QUERIES env var for testing — comma-separated, e.g. "fhir,hl7".
const DEFAULT_QUERIES = [
  'fhir',
  'hl7',
  'healthcare-architect',
  'solution-architect',
  'senior-architect',
  'integration-architect',
  'healthcare-integration',
  'ehr',
];
// Query precedence: HIRIST_QUERIES env override → user's curated resume-fit roles
// (slugified for Hirist's /k/<slug>-jobs URLs) → hardcoded DEFAULT_QUERIES.
// Roles are resolved from the DB inside main() (after the handle is open).
const ENV_QUERIES = process.env.HIRIST_QUERIES
  ? process.env.HIRIST_QUERIES.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

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

const insertStmt = db.prepare(`
  INSERT INTO job_postings (source, company, title, location, description, url, domain_priority, remote_policy, visa_sponsorship, relocation_offered, dedup_hash, posted_at, last_seen_at, source_present)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(dedup_hash) DO UPDATE SET
    last_seen_at = CURRENT_TIMESTAMP,
    source_present = 1,
    posted_at = COALESCE(excluded.posted_at, posted_at)
`);

const checkExistsStmt = db.prepare('SELECT 1 FROM job_postings WHERE dedup_hash = ? LIMIT 1');
// Refresh presence for an already-seen job without re-fetching its detail page — keeps
// last_seen_at current so prune-stale doesn't retire jobs we deliberately skipped.
const touchStmt = db.prepare('UPDATE job_postings SET last_seen_at = CURRENT_TIMESTAMP, source_present = 1 WHERE dedup_hash = ?');

interface ListingCard {
  title: string;
  url: string;
  experience: string;
  location: string;
}

async function scrapeListing(page: Page, slug: string): Promise<ListingCard[]> {
  const url = `https://www.hirist.tech/k/${slug}-jobs`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Hirist hydrates with React; wait a beat for cards to populate.
  try {
    await page.waitForSelector('.joblist-card-v2', { timeout: 12_000 });
  } catch {
    return [];
  }
  // Allow lazy-loaded list items to settle
  await page.waitForTimeout(1500);

  const cards: ListingCard[] = await page.evaluate(() => {
    const out: ListingCard[] = [];
    document.querySelectorAll('.joblist-card-v2').forEach((card) => {
      const a = card.querySelector('a[href*="/j/"]') as HTMLAnchorElement | null;
      const title = (card.querySelector('[data-testid="job_title"]') as HTMLElement | null)?.innerText?.trim() || '';
      const experience = (card.querySelector('[data-testid="job_experience"]') as HTMLElement | null)?.innerText?.trim() || '';
      const location = (card.querySelector('[data-testid="job_location"]') as HTMLElement | null)?.innerText?.trim() || '';
      const url = a?.href || '';
      if (url && title) out.push({ title, url, experience, location });
    });
    return out;
  });
  return cards;
}

async function fetchDetail(page: Page, url: string): Promise<{ company: string; description: string } | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('[data-testid="job-description-container"], h1', { timeout: 10_000 });
    await page.waitForTimeout(800);
    return await page.evaluate(() => {
      const text = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.innerText?.trim() || '';
      const company = text('[data-testid="company-name"]');
      const description = text('[data-testid="job-description-container"]');
      return { company, description };
    });
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('Ingesting from Hirist (Playwright)...');
  markSourceAbsent(db, 'hirist');
  // Resolve search queries: env override → curated roles (slugified) → defaults.
  const SEARCH_QUERIES = ENV_QUERIES ?? (() => {
    const roles = getEnabledRoles(db).map(slugify).filter(Boolean);
    return roles.length ? roles : DEFAULT_QUERIES;
  })();
  console.log(`  ${SEARCH_QUERIES.length} queries: ${SEARCH_QUERIES.join(', ')}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  let totalScanned = 0;
  let totalAdded = 0;
  let totalSkipped = 0;

  for (const q of SEARCH_QUERIES) {
    try {
      console.log(`  → "${q}"`);
      const cards = await scrapeListing(page, q);
      console.log(`     scraped ${cards.length} cards`);
      totalScanned += cards.length;

      for (const card of cards) {
        // Title from listing carries "Company - Role" pattern; we still hit detail for clean company + JD.
        // Pre-dedup by title+location+url to avoid wasting detail fetches on already-seen jobs.
        // Use a placeholder company until we get the real one from the detail page.
        const tentativeHash = createHash('sha256').update('hirist|' + card.title + '|' + card.location).digest('hex');
        const exists = checkExistsStmt.get(tentativeHash);
        if (exists) {
          touchStmt.run(tentativeHash); // refresh presence without a detail fetch
          totalSkipped++;
          continue;
        }

        const detail = await fetchDetail(page, card.url);
        await sleep(2500);
        if (!detail) continue;

        const company = detail.company || (card.title.split(/\s*-\s*/)[0] || 'Unknown').slice(0, 80);
        const description = detail.description.slice(0, 8000);
        const dp = isDomainPriority(card.title + ' ' + description);
        const cls = classifyJob(card.title, description, card.location);
        const finalHash = createHash('sha256').update('hirist|' + card.title + '|' + card.location).digest('hex');

        const result = insertStmt.run(
          'hirist',
          company,
          card.title,
          card.location,
          description,
          card.url,
          dp ? 1 : 0,
          cls.remote_policy,
          cls.visa_sponsorship,
          cls.relocation_offered,
          finalHash,
          null // posted_at — Hirist listing doesn't expose a reliable date
        );
        if (result.changes > 0) totalAdded++;
      }

      await sleep(4000);
    } catch (e) {
      console.log(`     ✗ search error: ${(e as Error).message}`);
      await sleep(8000);
    }
  }

  await browser.close();
  console.log(`Hirist complete. Scanned ${totalScanned}, skipped (already in DB) ${totalSkipped}, added ${totalAdded}.`);
  if (totalScanned === 0) {
    console.log('  ⚠ Zero cards scraped — Hirist likely blocked or selectors changed. Check scripts/diag-hirist-deep.ts.');
  }
  db.close();
}

main().catch((err) => {
  console.error('Hirist error:', err.message);
  db.close();
});
