// Naukri jobs ingest via Playwright. Naukri's frontend renders client-side behind
// bot detection. Playwright launches Chromium with a persistent context, navigates the
// search page, intercepts the internal search API (/jobapi/v3/search) for instant, rich
// job data and direct apply flags, and seamlessly falls back to DOM extraction if needed.
//
// FEATURES & OPTIMIZATIONS:
//  - Intercepts Naukri's /jobapi/v3/search to extract all 20 jobs per page in ~3s.
//  - Directly identifies Direct Apply (chatbot) vs External Apply (company site) via
//    `companyApplyJob` flag without needing slow, error-prone detail page navigations.
//  - Resilient browser & page management: automatically re-opens pages or re-launches
//    browser if closed/crashed, preventing 18+ minute frozen loops.
//  - Dynamic profile role, location, seniority, and experience filtering.
//  - Real-time embedding generation for newly added direct apply jobs.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { chromium, type Page, type BrowserContext, type Response } from 'playwright';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';
import { getEnabledRoles, getEnabledLocations, getProfileYoe, resolveSearchRoles, isDomainPriorityJob } from './shared/profile-roles';
import { detectNaukriEasyApply } from '../src/lib/apply/naukri';
import {
  matchesPreferredRole,
  isSeniorityCompatible,
  isExperienceCompatible,
  isLocationCompatible,
} from '../src/lib/target-job-filter';
import { generateEmbedding, embeddingToBlob } from '../src/lib/embeddings';

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
  'Software Engineer',
  'Solution Architect',
  'Data Engineer',
  'Full Stack Developer',
  'Systems Engineer',
];

const freshnessDays = process.env.SYNC_FRESHNESS_DAYS ? Number(process.env.SYNC_FRESHNESS_DAYS) : 7;

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.HIREME_DB || process.env.HIRESIGNAL_DB || path.join(DATA_DIR, 'hireme.db');
const db = new Database(DB_PATH);
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
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

const checkExistsStmt = db.prepare(
  "SELECT id, apply_type FROM job_postings WHERE (source = 'naukri' OR source_platform = 'naukri') AND url = ? LIMIT 1",
);
const touchStmt = db.prepare(
  "UPDATE job_postings SET last_seen_at = CURRENT_TIMESTAMP, source_present = 1 WHERE (source = 'naukri' OR source_platform = 'naukri') AND url = ?",
);
const updateApplyTypeStmt = db.prepare(
  "UPDATE job_postings SET apply_type = ?, last_seen_at = CURRENT_TIMESTAMP, source_present = 1 WHERE (source = 'naukri' OR source_platform = 'naukri') AND url = ?",
);

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
  applyType?: 'direct_apply' | 'external' | 'unknown';
  minExp?: number;
  maxExp?: number;
}

function cleanHtmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function scrapeSearch(page: Page, keywords: string, location: string, yoe: number, pageNum = 1): Promise<ScrapedJob[]> {
  const roleSlug = keywords.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const locSlug = location ? location.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
  const baseSlug = locSlug ? `${roleSlug}-jobs-in-${locSlug}` : `${roleSlug}-jobs`;
  const url =
    pageNum === 1
      ? `https://www.naukri.com/${baseSlug}?experience=${Math.floor(yoe)}&freshness=${freshnessDays}`
      : `https://www.naukri.com/${baseSlug}-${pageNum}?experience=${Math.floor(yoe)}&freshness=${freshnessDays}`;

  const apiResult: { jobs: ScrapedJob[] | null } = { jobs: null };
  const onResponse = async (res: Response) => {
    if (res.url().includes('/jobapi/v3/search')) {
      try {
        const json = await res.json();
        if (Array.isArray(json?.jobDetails) && json.jobDetails.length > 0) {
          apiResult.jobs = json.jobDetails.map((j: any) => {
            const locPlaceholder = j.placeholders?.find((p: any) => p.type === 'location')?.label || '';
            const expPlaceholder = j.placeholders?.find((p: any) => p.type === 'experience')?.label || '';
            const desc = cleanHtmlText(j.jobDescription || '');
            const fullDesc = [
              expPlaceholder ? `Experience: ${expPlaceholder}` : '',
              j.tagsAndSkills ? `Skills: ${j.tagsAndSkills}` : '',
              desc,
            ].filter(Boolean).join('\n');

            let postedAt: string | null = null;
            if (j.createdDate) {
              try { postedAt = new Date(Number(j.createdDate)).toISOString().slice(0, 10); } catch {}
            }

            const applyType: 'direct_apply' | 'external' = j.companyApplyJob ? 'external' : 'direct_apply';
            const jobUrl = j.jdURL ? (j.jdURL.startsWith('http') ? j.jdURL : `https://www.naukri.com${j.jdURL}`) : '';

            return {
              title: j.title?.trim() || '',
              company: j.companyName?.trim() || 'Unknown',
              location: locPlaceholder,
              description: fullDesc,
              url: jobUrl,
              postedAt,
              applyType,
              minExp: j.minimumExperience ? parseInt(j.minimumExperience, 10) : undefined,
              maxExp: j.maximumExperience ? parseInt(j.maximumExperience, 10) : undefined,
            };
          }).filter((j: ScrapedJob) => j.title && j.url);
        }
      } catch {
        // response was not JSON or parsing failed
      }
    }
  };

  page.on('response', onResponse);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Brief poll to allow the search API response to process
    for (let i = 0; i < 8; i++) {
      if (apiResult.jobs && apiResult.jobs.length > 0) break;
      await page.waitForTimeout(250);
    }
  } finally {
    page.off('response', onResponse);
  }

  if (apiResult.jobs && apiResult.jobs.length > 0) {
    return apiResult.jobs;
  }


  // Fallback to DOM parsing if API response was unavailable
  try {
    await page.waitForSelector('.cust-job-tuple, [class*="srp-jobtuple-wrapper"], .jobTuple, [class*="job-tuple"]', { timeout: 8_000 });
  } catch {
    const bodyHead = await page.evaluate(() => document.body.innerText.slice(0, 120)).catch(() => '');
    if (/access denied/i.test(bodyHead)) {
      console.log('     ✗ Naukri blocked this run (Akamai access denied).');
    }
    return [];
  }

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
      const cardUrl = titleEl?.href || '';
      if (!title || !cardUrl || seenUrls.has(cardUrl)) return;
      seenUrls.add(cardUrl);

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

      out.push({ title, company, location, description, url: cardUrl, postedAt, applyType: 'unknown' });
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(2000);

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

async function launchNaukriBrowser(profileDir: string): Promise<BrowserContext> {
  const isVisible = process.env.SHOW_BROWSER === '1' || process.env.DEBUG === '1';
  const customArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-infobars',
    ...(isVisible ? ['--start-maximized'] : ['--window-position=-2400,-2400', '--window-size=1366,768']),
  ];

  let browser: BrowserContext;
  try {
    browser = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: customArgs,
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'en-IN',
    });
  } catch {
    browser = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      args: customArgs,
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'en-IN',
    });
  }

  await browser.addInitScript(() => {
    try {
      delete (Object.getPrototypeOf(navigator) as any).webdriver;
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {}
  });

  return browser;
}

function isContextValid(browser: BrowserContext): boolean {
  try {
    return Array.isArray(browser.pages());
  } catch {
    return false;
  }
}

async function getOrRestorePage(browser: BrowserContext): Promise<Page> {
  try {
    const openPages = browser.pages().filter((p) => !p.isClosed());
    if (openPages.length > 0) {
      return openPages[0];
    }
    return await browser.newPage();
  } catch {
    return await browser.newPage();
  }
}


async function main() {
  console.log('Ingesting from Naukri (Playwright via Google Chrome)...');
  markSourceAbsent(db, 'naukri');
  const SEARCH_QUERIES = resolveSearchRoles(db, DEFAULT_QUERIES);
  const yoe = getProfileYoe(db);
  console.log(`  ${SEARCH_QUERIES.length} queries: ${SEARCH_QUERIES.join(', ')}`);
  console.log(`  Experience filter: ${yoe} year(s)`);

  const PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // Ensure login cookies and local state are synced from system Chrome if present
  try {
    const localAppData = process.env.LOCALAPPDATA || '';
    const sysUserData = path.join(localAppData, 'Google', 'Chrome', 'User Data');
    const sysCookies = path.join(sysUserData, 'Default', 'Network', 'Cookies');
    const dstCookies = path.join(PROFILE_DIR, 'Default', 'Network', 'Cookies');
    if (fs.existsSync(sysCookies)) {
      const dstNet = path.dirname(dstCookies);
      if (!fs.existsSync(dstNet)) fs.mkdirSync(dstNet, { recursive: true });
      fs.copyFileSync(sysCookies, dstCookies);
      const sysLocalState = path.join(sysUserData, 'Local State');
      if (fs.existsSync(sysLocalState)) {
        fs.copyFileSync(sysLocalState, path.join(PROFILE_DIR, 'Local State'));
      }
      const sysPref = path.join(sysUserData, 'Default', 'Preferences');
      const dstPref = path.join(PROFILE_DIR, 'Default', 'Preferences');
      if (fs.existsSync(sysPref)) {
        fs.copyFileSync(sysPref, dstPref);
      }
    }
  } catch {}

  let browser = await launchNaukriBrowser(PROFILE_DIR);
  let page = await getOrRestorePage(browser);

  const userLocations = getEnabledLocations(db);
  const targetLocations = userLocations.length > 0 ? userLocations : [''];
  const targetRoles = getEnabledRoles(db);

  let totalAdded = 0;
  let totalScanned = 0;
  const MAX_NEW_JOBS_PER_SYNC = 150;

  for (const q of SEARCH_QUERIES) {
    if (totalAdded >= MAX_NEW_JOBS_PER_SYNC) break;

    for (const loc of targetLocations) {
      if (totalAdded >= MAX_NEW_JOBS_PER_SYNC) break;

      for (const pageNum of [1, 2]) {
        if (totalAdded >= MAX_NEW_JOBS_PER_SYNC) break;

        try {
          // Verify browser & page health before each query
          if (!isContextValid(browser)) {
            console.log('[Naukri] 🔄 Reconnecting browser context...');
            browser = await launchNaukriBrowser(PROFILE_DIR);
            page = await getOrRestorePage(browser);
          } else {
            page = await getOrRestorePage(browser);
          }

          console.log(`[Naukri] 🔍 Searching: "${q}" in ${loc || 'All India'} (page ${pageNum}, last ${freshnessDays}d)...`);
          const jobs = await scrapeSearch(page, q, loc, yoe, pageNum);
          console.log(`[Naukri] 📋 Found ${jobs.length} job cards on Naukri for "${q}" in ${loc || 'All India'} (page ${pageNum})`);
          totalScanned += jobs.length;

          for (const job of jobs) {
            if (!job.url) continue;

            // Fast pre-filter: skip non-target roles immediately
            if (targetRoles.length > 0 && !matchesPreferredRole(job.title, targetRoles)) {
              console.log(`[Naukri] ⏭️ Skipped: "${job.title}" at ${job.company} (Non-target role)`);
              continue;
            }

            // Fast pre-filter: skip high-seniority roles immediately
            if (!isSeniorityCompatible(job.title, yoe, targetRoles)) {
              console.log(`[Naukri] ⏭️ Skipped: "${job.title}" at ${job.company} (Seniority > candidate reach)`);
              continue;
            }

            // Fast pre-filter: skip obvious experience mismatches
            if (!isExperienceCompatible(job.minExp, job.maxExp, `${job.title} ${job.url} ${job.description}`, yoe)) {
              console.log(`[Naukri] ⏭️ Skipped: "${job.title}" at ${job.company} (Experience mismatch)`);
              continue;
            }

            // Location compatibility check
            if (targetLocations.length > 0 && job.location && !isLocationCompatible(job.location, null, targetLocations)) {
              console.log(`[Naukri] ⏭️ Skipped: "${job.title}" at ${job.company} (Location mismatch)`);
              continue;
            }

            let applyType: 'direct_apply' | 'external' | 'unknown' = job.applyType || 'unknown';

            // Check if already in DB
            const existing = checkExistsStmt.get(job.url) as { id: number; apply_type: string | null } | undefined;
            if (existing) {
              const knownType = existing.apply_type;
              if (knownType && knownType !== 'unknown') {
                touchStmt.run(job.url);
                continue;
              }
              if (applyType !== 'unknown') {
                updateApplyTypeStmt.run(applyType, job.url);
                continue;
              }
              touchStmt.run(job.url);
              continue;
            }

            // If applyType is still unknown (e.g. DOM fallback) or description is missing, fetch details safely
            let desc = job.description;
            const doClassify = process.env.NAUKRI_CLASSIFY_APPLY !== '0';
            const needDesc = !desc;

            if ((needDesc || (doClassify && applyType === 'unknown')) && job.url) {
              try {
                page = await getOrRestorePage(browser);
                const details = await fetchJobDetailsAndApplyType(page, job.url, needDesc, doClassify && applyType === 'unknown');
                if (details.description && details.description.length > (desc?.length || 0)) {
                  desc = details.description;
                }
                if (details.applyType !== 'unknown') {
                  applyType = details.applyType;
                }
              } catch {}
              await sleep(1500);
            }

            if (applyType === 'direct_apply') {
              console.log(`[Naukri] 🎯 Found Direct Apply: "${job.title}" at ${job.company}`);
            } else if (applyType === 'external') {
              console.log(`[Naukri] ℹ️ Found External Apply: "${job.title}" at ${job.company}`);
            }

            // Default: Ingest direct apply jobs for in-app automation
            if (process.env.NAUKRI_ALL_APPLY !== '1' && applyType !== 'direct_apply') {
              console.log(`[Naukri] ⏭️ Skipped: "${job.title}" at ${job.company} (Not Direct Apply)`);
              continue;
            }

            const dp = isDomainPriorityJob(db, job.title + ' ' + desc);
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
              console.log(`[Naukri] 📥 Ingested: "${job.title}" at ${job.company} [${applyType === 'direct_apply' ? 'Direct Apply' : 'External'}]`);
              try {
                const emb = await generateEmbedding(`${job.title} ${job.company} ${(desc || '').slice(0, 2000)}`);
                const blob = embeddingToBlob(emb);
                db.prepare('UPDATE job_postings SET embedding = ? WHERE rowid = ?').run(blob, result.lastInsertRowid);
              } catch { /* embed-jobs fallback */ }
            } else {
              console.log(`[Naukri] ℹ️ Already in database: "${job.title}" at ${job.company}`);
            }
          }

          await sleep(2500);
        } catch (e) {
          const errMsg = (e as Error).message;
          console.log(`[Naukri] ✗ search error: ${errMsg}`);
          if (/target page|context or browser has been closed|closed/i.test(errMsg)) {
            try {
              if (!isContextValid(browser)) {
                browser = await launchNaukriBrowser(PROFILE_DIR);
              }
              page = await getOrRestorePage(browser);
            } catch {}
          }
          await sleep(4000);
        }
      }
    }
  }

  try {
    await browser.close();
  } catch {}
  console.log(`Naukri complete. Added ${totalAdded} of ${totalScanned} scanned.`);
  if (totalAdded === 0 && totalScanned > 0) {
    console.log('  ⚠ Scraped cards but added zero — likely all duplicates from a previous run.');
  }
  if (totalScanned === 0) {
    console.log('  ⚠ Zero cards scraped — Naukri likely blocked or required login.');
    console.log('    Run "npm run login:naukri" in terminal to sign into your Naukri account in Chrome.');
  }
  db.close();
}

main().catch(async (err) => {
  console.error('Naukri error:', err.message);
  db.close();
});
