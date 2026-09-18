// Levels.fyi compensation lookup. Fetches the public per-company comp page,
// parses the embedded __NEXT_DATA__ JSON, and returns structured comp records.
//
// Pattern: lazy on-view caching. The /api/companies/[slug]/compensation route
// hits this once per (company, region), stores the result in the
// `compensation_data` table, and serves cached responses thereafter.
//
// CAVEATS:
// - Levels.fyi pages are React-hydrated; we use Playwright to wait for hydration
//   then read __NEXT_DATA__ from the resulting DOM.
// - Levels.fyi may rate-limit aggressive scraping. The per-view cache pattern
//   means realistic usage is one fetch per unique company you actually open.
// - Levels.fyi country IDs: 254=US, 43=India.

import { chromium, type Browser } from 'playwright';

export type Region = 'US' | 'IN';

interface RawTitle { count: number; title: string; total: number; title_slug: string; }
interface RawLevel { count: number; level: string; total: number; level_slug: string; }
interface RawJobFamily {
  name: string;        // e.g. "Software Engineer"
  slug: string;        // e.g. "software-engineer"
  titles?: RawTitle[]; // optional; not all families have title-level breakdowns
  breakdown?: RawLevel[];
}

export interface LevelsCompData {
  companySlug: string;
  region: Region;
  sourceUrl: string;
  currency: string;
  medianTotalUsd: number | null;
  sampleCount: number;
  jobFamilies: RawJobFamily[]; // from __NEXT_DATA__'s overview array
}

const COUNTRY_ID: Record<Region, string> = { US: '254', IN: '43' };

// Convert a company name to Levels.fyi's URL slug. Their format is lowercase, hyphens.
// e.g. "Oscar Health" → "oscar-health", "1upHealth" → "1uphealth".
export function toLevelsSlug(companyName: string): string {
  return companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let sharedBrowser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

// Parse one Levels.fyi page → structured comp data. Returns null if the page is
// missing or blocked, or if no comp records are found.
export async function fetchLevelsCompensation(companySlug: string, region: Region = 'US'): Promise<LevelsCompData | null> {
  const baseUrl = `https://www.levels.fyi/companies/${companySlug}/salaries`;
  const url = region === 'IN' ? `${baseUrl}?country=${COUNTRY_ID.IN}` : baseUrl;

  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: region === 'IN' ? 'en-IN' : 'en-US',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2500);

    const nextDataText = await page.evaluate(() => {
      const el = document.querySelector('script#__NEXT_DATA__') as HTMLScriptElement | null;
      return el?.textContent || null;
    });
    if (!nextDataText) return null;

    let json: unknown;
    try {
      json = JSON.parse(nextDataText);
    } catch {
      return null;
    }
    const pageProps = (json as { props?: { pageProps?: Record<string, unknown> } })?.props?.pageProps;
    if (!pageProps) return null;

    const overview = (pageProps.overview as RawJobFamily[] | undefined) || [];
    if (overview.length === 0) return null;

    // Levels.fyi convention: `total` fields are ALWAYS in USD, regardless of the page's
    // display locale. `locationCurrency` + `locationExchangeRate` are only used by their
    // front-end to render in local currency. So we store totals as-is (USD).
    const currency = ((pageProps.locationCurrency as string) || 'USD').toUpperCase();

    const allTotals: number[] = [];
    let sampleCount = 0;
    for (const fam of overview) {
      for (const lvl of fam.breakdown || []) {
        if (typeof lvl.total === 'number' && lvl.total > 0) {
          allTotals.push(lvl.total);
          sampleCount += lvl.count || 0;
        }
      }
    }
    allTotals.sort((a, b) => a - b);
    const medianUsd = allTotals.length > 0
      ? Math.round(allTotals[Math.floor(allTotals.length / 2)])
      : null;

    return {
      companySlug,
      region,
      sourceUrl: url,
      currency,
      medianTotalUsd: medianUsd,
      sampleCount,
      jobFamilies: overview,
    };
  } catch (err) {
    console.warn('[levels] fetch failed', companySlug, region, (err as Error).message);
    return null;
  } finally {
    await ctx.close();
  }
}

// Find the comp record in the breakdown most relevant to a given role title.
// Heuristic: substring-match the title's keywords against the family name + title list.
export interface RoleCompMatch {
  jobFamily: string;     // e.g. "Software Engineer"
  level?: string;        // e.g. "E5"
  totalAtLevel?: number; // total for the matched level (in source currency)
  totalForFamily?: number; // family-level median (when no level match)
  sampleCount: number;
  matchSource: 'title' | 'level' | 'family' | 'none';
}

const FAMILY_KEYWORDS: Array<{ family: string; patterns: RegExp[] }> = [
  { family: 'Software Engineer', patterns: [/\bsoftware engineer\b/i, /\bbackend\b/i, /\bfrontend\b/i, /\bfull[- ]?stack\b/i, /\bdeveloper\b/i, /\bSDE\b/, /\bSWE\b/] },
  { family: 'Engineering Manager', patterns: [/\bengineering manager\b/i, /\bem\b/i, /\bteam lead\b/i, /\btech lead\b/i, /\blead engineer\b/i] },
  { family: 'Solutions Architect', patterns: [/\barchitect\b/i, /\bsolutions architect\b/i, /\btechnical architect\b/i] },
  { family: 'Data Scientist', patterns: [/\bdata scientist\b/i, /\bds\b/i] },
  { family: 'Data Engineer', patterns: [/\bdata engineer\b/i] },
  { family: 'Product Manager', patterns: [/\bproduct manager\b/i, /\bpm\b/i, /\bproduct owner\b/i] },
  { family: 'DevOps Engineer', patterns: [/\bdevops\b/i, /\bsre\b/i, /\bsite reliability\b/i, /\bplatform engineer\b/i] },
  { family: 'Designer', patterns: [/\bux designer\b/i, /\bui designer\b/i, /\bproduct designer\b/i] },
];

const SENIORITY_HINTS: Array<{ level: string; patterns: RegExp[] }> = [
  { level: 'E1', patterns: [/\bjunior\b/i, /\bentry\b/i, /\bgrad\b/i, /\bjr\.?\b/i] },
  { level: 'E2', patterns: [/^(?!.*senior).*\bengineer\b/i] }, // weak — overridden by stronger matches
  { level: 'E3', patterns: [/\bsenior\b/i, /\bsr\.?\b/i] },
  { level: 'E4', patterns: [/\blead\b/i, /\bstaff\b/i] },
  { level: 'E5', patterns: [/\bprincipal\b/i, /\bdistinguished\b/i, /\barchitect\b/i] },
  { level: 'E6', patterns: [/\bdirector\b/i, /\bvp\b/i, /\bhead of\b/i] },
];

export function findRelevantComp(comp: LevelsCompData, jobTitle: string): RoleCompMatch | null {
  const title = jobTitle || '';
  // 1. Match a job family
  let chosen: RawJobFamily | null = null;
  for (const fk of FAMILY_KEYWORDS) {
    if (fk.patterns.some((re) => re.test(title))) {
      chosen = comp.jobFamilies.find((f) => f.name.toLowerCase().includes(fk.family.toLowerCase())) || null;
      if (chosen) break;
    }
  }
  // Fallback: pick the largest job family by sample count
  if (!chosen) {
    chosen =
      comp.jobFamilies.reduce<{ fam: RawJobFamily | null; n: number }>(
        (acc, f) => {
          const n = (f.breakdown || []).reduce((s, b) => s + (b.count || 0), 0);
          return n > acc.n ? { fam: f, n } : acc;
        },
        { fam: null, n: 0 },
      ).fam;
  }
  if (!chosen) return null;

  // 2. Try level match within that family
  let matchedLevel: RawLevel | null = null;
  for (const lh of SENIORITY_HINTS) {
    if (!lh.patterns.some((re) => re.test(title))) continue;
    const found = (chosen.breakdown || []).find((b) => b.level === lh.level || b.level_slug === lh.level.toLowerCase());
    if (found) {
      matchedLevel = found;
      break;
    }
  }

  if (matchedLevel) {
    return {
      jobFamily: chosen.name,
      level: matchedLevel.level,
      totalAtLevel: matchedLevel.total,
      sampleCount: matchedLevel.count,
      matchSource: 'level',
    };
  }
  // Family-level fallback: take median total of all levels in this family
  const levels = chosen.breakdown || [];
  if (levels.length === 0) return null;
  const totals = levels.map((l) => l.total).sort((a, b) => a - b);
  const median = totals[Math.floor(totals.length / 2)];
  const totalSamples = levels.reduce((s, l) => s + (l.count || 0), 0);
  return {
    jobFamily: chosen.name,
    totalForFamily: median,
    sampleCount: totalSamples,
    matchSource: 'family',
  };
}

// Manual cleanup hook — close the shared browser before the process exits.
export async function shutdownLevelsBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}
