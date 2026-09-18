// Generic careers-page crawler — the fallback when detectAts() finds no known ATS.
//
// Heuristic and best-effort by nature (every custom careers site is different):
//   1. Prefer schema.org JobPosting JSON-LD (many sites embed it) — clean, structured.
//   2. Else scrape anchor links that look like job postings and visit a bounded number
//      to extract a title + body text.
//
// Playwright is imported lazily inside the function so importing this module has no cost /
// side effects (safe from Next routes and ts-node scripts). Always returns [] on failure.

import type { NormalizedJob } from './ats-pull';
import type { Browser } from 'playwright';

const JOB_HREF_RE = /(job|career|position|opening|vacanc|apply|role)s?[\/=]/i;
const MAX_DETAIL_VISITS = 25;

export interface CrawlOptions {
  /** Optional shared Playwright Browser. When provided this function will NOT close it. */
  browser?: unknown;
  company?: string;
  maxJobs?: number;
}

export async function crawlCareersPage(url: string, opts: CrawlOptions = {}): Promise<NormalizedJob[]> {
  const company = opts.company || hostToName(url);
  const maxJobs = Math.min(opts.maxJobs ?? MAX_DETAIL_VISITS, 60);

  // `opts.browser` lets a caller hand in ONE Chromium and reuse it across many crawls. Launching a
  // browser per call meant a full cold start for every seed that fell through to a crawl — with
  // 160 seeds that is up to 160 launches instead of one, and it was the largest single cost in the
  // discover step (measured 27-107 min for the step overall).
  const externalBrowser = opts.browser as Browser | undefined;
  let browser: Browser;
  if (externalBrowser) {
    browser = externalBrowser;
  } else {
    // Lazy import so module load stays free.
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500); // let client-rendered lists hydrate

    // 1. JSON-LD JobPosting (best case).
    const fromLd = await extractJsonLd(page, company);
    if (fromLd.length) return fromLd.slice(0, maxJobs);

    // 2. Heuristic anchor scrape.
    const base = new URL(url);
    const links: Array<{ href: string; text: string }> = await page.$$eval('a[href]', (as) =>
      as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent || '').trim() }))
    );
    const seen = new Set<string>();
    const candidates = links.filter((l) => {
      if (!l.href || !l.text || l.text.length < 4 || l.text.length > 120) return false;
      if (!JOB_HREF_RE.test(l.href)) return false;
      let sameHostOrAts = false;
      try {
        const h = new URL(l.href).hostname;
        sameHostOrAts = h === base.hostname || /greenhouse|lever|ashby|recruitee|workday|smartrecruiters/i.test(h);
      } catch { return false; }
      if (!sameHostOrAts) return false;
      if (seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    });

    const out: NormalizedJob[] = [];
    for (const c of candidates.slice(0, maxJobs)) {
      try {
        await page.goto(c.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(800);
        const title = (await page.$eval('h1', (el) => el.textContent?.trim() || '').catch(() => '')) || c.text;
        const description = await page.$eval('main, article, body', (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 8000)).catch(() => '');
        // Filter HERE too — this is the heuristic link-scrape path, and it is the one that produces
        // the junk (category links and slogans). The JSON-LD path below is structured data and is
        // usually clean, but both are guarded.
        if (title && looksLikeJobTitle(title)) {
          out.push({ title, company, location: '', description, url: c.href, posted_at: null });
        }
      } catch {
        // skip this listing
      }
    }
    if (out.length === 0) {
      console.log(`  [crawl] ${company}: no page yielded a plausible job title — skipping (careers site is not machine-readable)`);
    }
    return out;
  } catch {
    return [];
  } finally {
    // Only close a browser we launched — never the caller's shared one.
    if (!externalBrowser) await browser.close().catch(() => {});
  }
}

async function extractJsonLd(page: import('playwright').Page, company: string): Promise<NormalizedJob[]> {
  try {
    const blocks: string[] = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent || ''));
    const jobs: NormalizedJob[] = [];
    for (const raw of blocks) {
      let parsed: any;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const items = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed];
      for (const item of items) {
        if (!item || item['@type'] !== 'JobPosting') continue;
        const loc = item.jobLocation?.address?.addressLocality || item.jobLocation?.address?.addressRegion || item.applicantLocationRequirements?.name || '';
        jobs.push({
          title: item.title || '',
          company: item.hiringOrganization?.name || company,
          location: typeof loc === 'string' ? loc : '',
          description: (item.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000),
          url: item.url || '',
          posted_at: item.datePosted || null,
        });
      }
    }
    // Drop anything that isn't plausibly a posting — see `looksLikeJobTitle`.
    const kept = jobs.filter((j) => looksLikeJobTitle(j.title));
    if (kept.length < jobs.length) {
      console.log(`  [crawl] ${company}: dropped ${jobs.length - kept.length} non-job link(s), kept ${kept.length}`);
    }
    return kept;
  } catch {
    return [];
  }
}


/**
 * Does this look like an actual job POSTING title, rather than a nav link or marketing copy?
 *
 * The heuristic crawl scrapes links off a careers page, and on big corporate sites those links are
 * mostly categories and slogans. Measured against real sites: Epic returned "Software Development"
 * and "Culinary"; Mayo returned "Excellence" and "job"; Availity returned "If it always feels like
 * work, you're doing it wrong." — 0 real postings between them.
 *
 * This guard matters MORE than it used to. The SmartRecruiters probe used to false-positive on every
 * unknown company, so an ATS was always "detected" and this crawl almost never ran. Fixing that
 * probe means the crawl now runs for every company without a public ATS API — i.e. exactly the big
 * corporate sites that produce this junk. Without a filter, fixing one bug would have poured
 * garbage into the match corpus (currently 98.1% clean).
 *
 * Deliberately conservative: it rejects only what is clearly not a posting. A false reject costs one
 * job; a false accept pollutes ranking for everyone.
 */
export function looksLikeJobTitle(title: string): boolean {
  const t = (title || '').trim();
  if (t.length < 4 || t.length > 120) return false;

  // Sentence-like: ends in punctuation, or contains a comma-spliced clause with a verb phrase.
  if (/[.!?]$/.test(t)) return false;
  // Marketing copy and nav labels are the two failure modes seen in the wild.
  if (/(you're|you are|we're|we are|it always|apply now|learn more|search jobs|view all|join our|our team|why work|benefits|culture|diversity|life at|students|alumni|newsletter|cookie|privacy|sign in|log in|create (an )?account)/i.test(t)) return false;
  // A single generic word ("Culinary", "Excellence", "job") is a category, not a posting.
  if (!/\s/.test(t)) return false;

  // Require something that actually names a role or a seniority.
  const ROLE = /(engineer|developer|architect|manager|analyst|scientist|designer|director|lead|specialist|consultant|administrator|technician|nurse|physician|pharmacist|therapist|coordinator|intern|associate|officer|head|principal|staff|counsel|programmer|devops|sre|qa|tester|writer|recruiter|accountant|auditor|actuary|pathologist|terminologist|representative|executive|partner|advisor|strateg|architecture|operations|scrum|product owner|data|security|support|success|sales)/i;
  return ROLE.test(t);
}

function hostToName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return 'Unknown';
  }
}
