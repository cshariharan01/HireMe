// Naukri jobs ingest via Playwright. Naukri's frontend renders entirely client-side
// behind their bot detection — neither the HTML page nor the API endpoint return job
// data without a real browser context. Playwright launches Chromium, navigates the
// search page, waits for the React app to populate, and reads jobs from the DOM.
//
// CAVEATS:
//  - First run downloads ~150MB Chromium (one-time, already done if you got this far).
//  - Each search loads a real browser page — slow (~10-15 sec per search).
//  - Naukri may still rate-limit. The script is polite (8 sec between searches).
//  - If selectors break, run with `headless: false` to see what's rendering.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { chromium, type Page } from 'playwright';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';
import { getEnabledRoles, getProfileYoe, resolveSearchRoles } from './shared/profile-roles';
import { detectNaukriEasyApply } from '../src/lib/apply/naukri';
import {
  isTargetDataRole,
  isSeniorityCompatible,
  isExperienceCompatible,
} from '../src/lib/target-job-filter';

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
const GLOBAL_REMOTE_RE = /\b(work from anywhere|remote worldwide|remote \(global\)|globally remote)\b/i;

function classifyJob(title: string, description: string, location: string): { remote_policy: string; visa_sponsorship: number; relocation_offered: number } {
  const haystack = `${title}\n${location}\n${description}`;
  const loc = (location || '').toLowerCase();
  let remote_policy: string;
  if (GLOBAL_REMOTE_RE.test(haystack) || /\b(work from anywhere|remote worldwide|globally remote)\b/i.test(haystack)) {
    remote_policy = 'global';
  } else if (/remote|work from home|wfh/i.test(loc) || /remote|work from home|wfh/i.test(title)) {
    remote_policy = 'remote';
  } else if (loc.includes('india') || /bengaluru|bangalore|mumbai|delhi|gurugram|noida|hyderabad|chennai|pune|kolkata/i.test(loc)) {
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

const DEFAULT_QUERIES = [
  'FHIR Architect',
  'HL7 Architect',
  'Healthcare Integration Architect',
  'Solution Architect Healthcare',
  'Senior Software Architect FHIR',
  'EHR Integration Engineer',
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
for (const spec of ['remote_policy TEXT', 'visa_sponsorship INTEGER DEFAULT 0', 'relocation_offered INTEGER DEFAULT 0', "apply_type TEXT DEFAULT 'unknown'"]) {
  try {
    db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`);
  } catch (e) {
    if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
  }
}
ensureFreshnessColumns(db);

const insertStmt = db.prepare(`
  INSERT INTO job_postings (source, source_platform, company, title, location, description, url, domain_priority, remote_policy, visa_sponsorship, relocation_offered, apply_type, dedup_hash, posted_at, last_seen_at, source_present)
  VALUES (?, 'naukri', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(dedup_hash) DO UPDATE SET
    last_seen_at = CURRENT_TIMESTAMP,
    source_present = 1,
    posted_at = COALESCE(excluded.posted_at, posted_at),
    apply_type = excluded.apply_type,
    source_platform = excluded.source_platform
`);

interface ScrapedJob {
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  postedAt?: string | null;
}

async function scrapeSearch(page: Page, keywords: string, yoe: number, pageNum = 1): Promise<ScrapedJob[]> {
  const slug = keywords.toLowerCase().replace(/\s+/g, '-');
  const url =
    pageNum === 1
      ? `https://www.naukri.com/${slug}-jobs?experience=${yoe}&freshness=1`
      : `https://www.naukri.com/${slug}-jobs-${pageNum}?experience=${yoe}&freshness=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Wait for the React app to populate the job list
  try {
    await page.waitForSelector('.cust-job-tuple, [class*="srp-jobtuple-wrapper"], .jobTuple, [class*="job-tuple"]', { timeout: 15_000 });
  } catch {
    const bodyHead = await page.evaluate(() => document.body.innerText.slice(0, 120)).catch(() => '');
    if (/access denied/i.test(bodyHead)) {
      console.log('     ✗ Naukri blocked this run (Akamai access denied).');
    }
    // No results or selector changed
    return [];
  }

  // Extract from DOM. Naukri uses CSS-modules, so class names have hash suffixes — match by prefix.
  const jobs: ScrapedJob[] = await page.evaluate(() => {
    const cards = document.querySelectorAll('.cust-job-tuple, [class*="srp-jobtuple-wrapper"], .jobTuple, [class*="job-tuple"]');
    const out: ScrapedJob[] = [];
    const seenUrls = new Set<string>();
    cards.forEach((card) => {
      const titleEl = card.querySelector('a.title, .title a, [class*="title"] a, a[class*="title"]') as HTMLAnchorElement | null;
      const companyEl = card.querySelector('.comp-name, [class*="comp-name"], .companyInfo a, a.subTitle') as HTMLElement | null;
      const locEl = card.querySelector('.locWdth, .location, [class*="location"] span, span[class*="loc"]') as HTMLElement | null;
      const expEl = card.querySelector('.expwdth, .exp-wrap, [class*="exp"] span, .experience, [class*="experience"]') as HTMLElement | null;
      const descEl = card.querySelector('.job-desc, [class*="job-desc"]') as HTMLElement | null;
      const title = titleEl?.textContent?.trim() || '';
      const url = titleEl?.href || '';
      if (!title || !url || seenUrls.has(url)) return;
      seenUrls.add(url);
      const dateEl = card.querySelector('.job-post-day, span[class*="day"], span[class*="date"], .jobTuple-footer span') as HTMLElement | null;
      const dateRaw = dateEl?.textContent?.trim() || '';
      let postedAt: string | null = null;
      if (/just now|few hours|today/i.test(dateRaw)) {
        postedAt = new Date().toISOString().slice(0, 10);
      } else if (/1\s*day\s*ago/i.test(dateRaw)) {
        postedAt = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      } else {
        const dm = dateRaw.match(/(\d+)\s*days?\s*ago/i);
        if (dm) {
          postedAt = new Date(Date.now() - parseInt(dm[1], 10) * 86400000).toISOString().slice(0, 10);
        }
      }

      const company = companyEl?.textContent?.trim() || 'Unknown';
      const location = locEl?.textContent?.trim() || '';
      const expText = expEl?.textContent?.trim() || '';
      let description = descEl?.textContent?.trim() || '';
      if (expText && !description.toLowerCase().includes(expText.toLowerCase())) {
        description = `Experience: ${expText}\n${description}`.trim();
      }

      out.push({ title, company, location, description, url, postedAt });
    });
    return out;
  });

  return jobs;
}

async function fetchJobDetailsAndApplyType(
  page: Page,
  url: string,
  needDescription: boolean,
  classifyApply: boolean
): Promise<{ description: string; applyType: 'direct_apply' | 'external' | 'unknown' }> {
  let description = '';
  let applyType: 'direct_apply' | 'external' | 'unknown' = 'unknown';

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    if (needDescription) {
      const descText = await page
        .locator(
          '.styles_JDC__dang-inner-html__h0K4t, [class*="JDC__dang-inner-html"], .dang-inner-html, [class*="job-desc"]'
        )
        .first()
        .textContent()
        .catch(() => '');
      if (descText) {
        description = descText.replace(/\s+/g, ' ').trim();
      }
    }

    if (classifyApply) {
      const isDirect = await detectNaukriEasyApply(page);
      applyType = isDirect ? 'direct_apply' : 'external';
    }
  } catch {
    // If navigation fails or times out, return defaults
  }

  return { description, applyType };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('Ingesting from Naukri (Playwright via Google Chrome)...');
  markSourceAbsent(db, 'naukri');
  const SEARCH_QUERIES = resolveSearchRoles(db, DEFAULT_QUERIES);
  const yoe = getProfileYoe(db);
  console.log(`  ${SEARCH_QUERIES.length} queries: ${SEARCH_QUERIES.join(', ')}`);
  console.log(`  Experience filter: ${yoe} year(s)`);
  
  // Use shared persistent Chrome profile where login sessions live
  const PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  let browser;
  try {
    browser = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'en-IN',
    });
  } catch {
    browser = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'en-IN',
    });
  }
  const page = browser.pages()[0] || (await browser.newPage());

  let totalAdded = 0;
  let totalScanned = 0;

  for (const q of SEARCH_QUERIES) {
    for (const pageNum of [1]) {
      try {
        console.log(`  → "${q}" (24h)`);
        const jobs = await scrapeSearch(page, q, yoe, pageNum);
        console.log(`     scraped ${jobs.length} cards`);
        totalScanned += jobs.length;

        for (const job of jobs) {
          // Fast pre-filter: skip non-target roles immediately
          if (!isTargetDataRole(job.title)) {
            console.log(`     skipped non-target role: ${job.title}`);
            continue;
          }

          // Fast pre-filter: skip high-seniority roles immediately
          if (!isSeniorityCompatible(job.title)) {
            console.log(`     skipped high-seniority: ${job.title}`);
            continue;
          }

          // Fast pre-filter: skip obvious > 4 YOE or < 3 YOE from URL slug / card description
          if (!isExperienceCompatible(null, null, `${job.title} ${job.url} ${job.description}`)) {
            console.log(`     skipped incompatible experience: ${job.title}`);
            continue;
          }

          let desc = job.description;
          let applyType: 'direct_apply' | 'external' | 'unknown' = 'unknown';

          const doClassify = process.env.NAUKRI_CLASSIFY_APPLY !== '0';
          const needDesc = !desc;

          if ((needDesc || doClassify) && job.url) {
            const details = await fetchJobDetailsAndApplyType(page, job.url, true, doClassify);
            if (details.description && details.description.length > (desc?.length || 0)) {
              desc = details.description;
            }
            if (doClassify) applyType = details.applyType;
            await sleep(2000);
          }

          // Re-check experience compatibility on the full JD description (e.g. catches "Minimum 4 years" masked by "1-3 years" URL slug)
          if (!isExperienceCompatible(null, null, `${job.title} ${job.url} ${desc}`)) {
            console.log(`     skipped incompatible experience in full JD: ${job.title}`);
            continue;
          }

          if (process.env.NAUKRI_ALL_APPLY !== '1' && applyType !== 'direct_apply') {
            console.log(`     skipped non-direct (${applyType}) job: ${job.title}`);
            continue;
          }

        const dp = isDomainPriority(job.title + ' ' + desc);
        const cls = classifyJob(job.title, desc, job.location);
        const hash = createHash('sha256').update('naukri' + job.company + job.title + job.location).digest('hex');
        const result = insertStmt.run(
          'naukri',
          job.company,
          job.title,
          job.location,
          desc.slice(0, 8000),
          job.url,
          dp ? 1 : 0,
          cls.remote_policy,
          cls.visa_sponsorship,
          cls.relocation_offered,
          applyType,
          hash,
          job.postedAt || null
        );
        if (result.changes > 0) {
          totalAdded++;
          console.log(`     ✓ direct apply saved: ${job.company} - ${job.title}`);
        } else {
          console.log(`     · direct apply updated: ${job.company} - ${job.title}`);
        }
      }
      await sleep(8000);
    } catch (e) {
      console.log(`     ✗ search error: ${(e as Error).message}`);
      await sleep(15000);
    }
  }
}

  await browser.close();
  console.log(`Naukri complete. Added ${totalAdded} of ${totalScanned} scanned.`);
  if (totalAdded === 0 && totalScanned > 0) {
    console.log('  ⚠ Scraped cards but added zero — likely all duplicates from a previous run.');
  }
  if (totalScanned === 0) {
    console.log('  ⚠ Zero cards scraped — Naukri likely blocked or selectors changed. Try again later.');
  }
  db.close();
}

main().catch(async (err) => {
  console.error('Naukri error:', err.message);
  db.close();
});
