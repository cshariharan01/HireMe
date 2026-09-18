// ATS detection — given a company name, careers URL, or homepage, figure out which Applicant
// Tracking System hosts its jobs so we can pull the whole board via a public API.
//
// Most "company career pages" are just an ATS front-end (Greenhouse / Lever / Ashby /
// SmartRecruiters / Recruitee / Workday). We detect two ways:
//   1. URL sniffing — if given a careers/home URL, fetch it and look for embedded ATS markers.
//   2. Slug probing — derive a slug from the name/URL and probe each ATS's public API.
//
// No side effects on import (fetch only) — safe from Next routes and ts-node scripts.

export type Ats =
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'smartrecruiters'
  | 'recruitee'
  | 'workday'
  | 'workable'
  | 'breezy'
  | 'pinpoint'
  | 'bamboohr'
  | 'personio'
  | 'teamtailor'
  | 'rippling'
  | 'manatal';

export interface AtsMatch {
  ats: Ats;
  slug: string;
  boardApi?: string;   // API endpoint we'll pull from (absent for workday → crawl fallback)
  supported: boolean;  // false = detected but no public-API pull (e.g. workday) → use crawl
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function get(url: string, timeoutMs = 12000): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA } });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Slugify a company name for ATS probing: "Cohere Health, Inc." → "coherehealth". */
function nameToSlugs(name: string): string[] {
  const base = name.toLowerCase().replace(/,?\s*(inc|llc|ltd|corp|gmbh|pvt|private limited)\.?$/i, '').trim();
  const compact = base.replace(/[^a-z0-9]/g, '');       // coherehealth
  const hyphen = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); // cohere-health
  return Array.from(new Set([compact, hyphen].filter(Boolean)));
}

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

// --- URL sniffing --------------------------------------------------------
// Recognize ATS from a URL directly (host patterns) or from markers in fetched HTML.
const URL_PATTERNS: Array<{ ats: Ats; re: RegExp; slugIdx: number }> = [
  { ats: 'greenhouse', re: /(?:job-boards|boards(?:\.[a-z]{2})?)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, slugIdx: 1 },
  { ats: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9-]+)/i, slugIdx: 1 },
  // Ashby has TWO shapes and the company lives in a different place in each:
  //   jobs.ashbyhq.com/<company>      -> company is in the PATH
  //   <company>.ashbyhq.com           -> company is the SUBDOMAIN
  // Only matching the subdomain captured the literal "jobs" for the first form. That is not a
  // harmless miss: sniffing CVS Health's careers page found an `//jobs.ashbyhq.com/...` link,
  // reported `ashby` with slug "jobs", pulled 0 jobs — and because an ATS had "been detected",
  // detection stopped there instead of going on to find their real board.
  { ats: 'ashby', re: /\/\/jobs\.ashbyhq\.com\/([a-z0-9-]+)/i, slugIdx: 1 },
  { ats: 'ashby', re: /\/\/(?!jobs\.)([a-z0-9-]+)\.ashbyhq\.com/i, slugIdx: 1 },
  { ats: 'lever', re: /jobs\.lever\.co\/([a-z0-9-]+)/i, slugIdx: 1 },
  { ats: 'workable', re: /apply\.workable\.com\/([a-z0-9-]+)/i, slugIdx: 1 },
  { ats: 'breezy', re: /\/\/([a-z0-9-]+)\.breezy\.hr/i, slugIdx: 1 },
  { ats: 'pinpoint', re: /\/\/([a-z0-9-]+)\.pinpointhq\.com/i, slugIdx: 1 },
  { ats: 'bamboohr', re: /\/\/([a-z0-9-]+)\.bamboohr\.com/i, slugIdx: 1 },
  { ats: 'personio', re: /\/\/([a-z0-9-]+)\.jobs\.personio\.(?:com|de)/i, slugIdx: 1 },
  { ats: 'teamtailor', re: /\/\/([a-z0-9-]+)\.teamtailor\.com/i, slugIdx: 1 },
  { ats: 'rippling', re: /ats\/v1\/board\/([a-z0-9-]+)/i, slugIdx: 1 },
  { ats: 'rippling', re: /\/\/ats\.rippling\.com\/([a-z0-9-]+)/i, slugIdx: 1 },
  { ats: 'manatal', re: /careers-page\.com\/([a-z0-9-]+)/i, slugIdx: 1 },
  { ats: 'manatal', re: /career-page\/([a-z0-9-]+)/i, slugIdx: 1 },
  { ats: 'recruitee', re: /\/\/([a-z0-9-]+)\.recruitee\.com/i, slugIdx: 1 },
  { ats: 'smartrecruiters', re: /smartrecruiters\.com\/([a-z0-9-]+)/i, slugIdx: 1 },
  // Workday: capture the WHOLE host + first path segment, because a pull needs three things —
  // tenant, data-centre host (wd1/wd3/wd5...) and site name. None can be guessed from a company
  // name: 15 attempts at plausible tenant/site pairs for Kaiser, HCA, Providence, Cigna and
  // Elevance produced 0 working boards (422 = valid tenant, wrong site; 404 = wrong tenant). It
  // has to come from the company's real careers URL, so Workday is URL-only by design.
  { ats: 'workday', re: /([a-z0-9-]+\.[a-z0-9]+\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?[A-Za-z0-9_-]+)/i, slugIdx: 1 },
];

function sniffString(s: string): AtsMatch | null {
  for (const { ats, re, slugIdx } of URL_PATTERNS) {
    const m = re.exec(s);
    if (m && m[slugIdx] && !['embed', 'www'].includes(m[slugIdx])) {
      return toMatch(ats, m[slugIdx]);
    }
  }
  return null;
}

function toMatch(ats: Ats, slug: string): AtsMatch {
  switch (ats) {
    case 'greenhouse': return { ats, slug, boardApi: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, supported: true };
    case 'workable': return { ats, slug, boardApi: `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`, supported: true };
    case 'breezy': return { ats, slug, boardApi: `https://${slug}.breezy.hr/json`, supported: true };
    case 'pinpoint': return { ats, slug, boardApi: `https://${slug}.pinpointhq.com/jobs.json`, supported: true };
    case 'bamboohr': return { ats, slug, boardApi: `https://${slug}.bamboohr.com/careers/list`, supported: true };
    case 'personio': return { ats, slug, boardApi: `https://${slug}.jobs.personio.com/xml`, supported: true };
    case 'teamtailor': return { ats, slug, boardApi: `https://${slug}.teamtailor.com/jobs.rss`, supported: true };
    case 'rippling': return { ats, slug, boardApi: `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`, supported: true };
    case 'manatal': return { ats, slug, boardApi: `https://api.manatal.com/open/v3/career-page/${slug}/jobs/`, supported: true };
    case 'ashby': return { ats, slug, boardApi: `https://api.ashbyhq.com/posting-api/job-board/${slug}`, supported: true };
    case 'lever': return { ats, slug, boardApi: `https://api.lever.co/v0/postings/${slug}?mode=json`, supported: true };
    case 'smartrecruiters': return { ats, slug, boardApi: `https://api.smartrecruiters.com/v1/companies/${slug}/postings`, supported: true };
    case 'recruitee': return { ats, slug, boardApi: `https://${slug}.recruitee.com/api/offers`, supported: true };
    case 'workday': {
      // `slug` here is "tenant.wdN.myworkdayjobs.com[/xx-XX]/Site" — everything pullBoard needs.
      const wd = parseWorkdaySlug(slug);
      return wd
        ? { ats, slug, boardApi: `https://${wd.host}/wday/cxs/${wd.tenant}/${wd.site}/jobs`, supported: true }
        : { ats, slug, supported: false };
    } // per-tenant CxS API varies → crawl fallback
  }
}

// --- API probing ---------------------------------------------------------
// Ask each ATS's public API whether this slug has an open board. First 200-with-jobs wins.

/**
 * Split a Workday board slug into the three parts an API pull needs.
 *
 * Input looks like `kaiser.wd1.myworkdayjobs.com/KPCareers` or
 * `acme.wd5.myworkdayjobs.com/en-US/External`. The locale segment, when present, is NOT part of the
 * site name and must be dropped — the JSON endpoint is locale-free.
 */
export function parseWorkdaySlug(
  slug: string,
): { host: string; tenant: string; site: string } | null {
  const m = /^([a-z0-9-]+)\.([a-z0-9]+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Z]{2})\/)?([A-Za-z0-9_-]+)/i.exec(
    (slug || '').replace(/^https?:\/\//i, ''),
  );
  if (!m) return null;
  const [, tenant, dc, , site] = m;
  if (!tenant || !dc || !site) return null;
  return { host: `${tenant}.${dc}.myworkdayjobs.com`, tenant, site };
}

/**
 * Hostname prefixes that name a FUNCTION, not a company — never usable as an ATS slug.
 * Several of these are real tenants on some ATS, which is what makes probing them harmful.
 */
const GENERIC_HOST_PREFIXES = new Set([
  'jobs', 'job', 'careers', 'career', 'apply', 'work', 'working', 'hiring', 'hire',
  'join', 'talent', 'recruiting', 'recruitment', 'people', 'employment', 'opportunities',
  // Infrastructure hosts. `api.rippling.com/...` derived the slug `api`, which matched an
  // unrelated Manatal board and attributed ITS jobs to the company being probed.
  'api', 'ats', 'board', 'boards', 'platform', 'app', 'my', 'portal', 'search',
]);


/** True when `body` parses to an object whose `key` is a non-empty array. */
function nonEmptyArray(body: string, key: string): boolean {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const v = j?.[key];
    return Array.isArray(v) && v.length > 0;
  } catch {
    return false;
  }
}

/** True when `body` parses to a non-empty top-level array. */
function nonEmptyTopLevelArray(body: string): boolean {
  try {
    const j = JSON.parse(body);
    return Array.isArray(j) && j.length > 0;
  } catch {
    return false;
  }
}

async function probeSlug(slug: string): Promise<AtsMatch | null> {
  const probes: Array<{ ats: Ats; url: string; ok: (r: Response, body: string) => boolean }> = [
    { ats: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, ok: (r, b) => r.ok && /"jobs"\s*:/.test(b) },
    { ats: 'lever', url: `https://api.lever.co/v0/postings/${slug}?mode=json`, ok: (r, b) => r.ok && b.trim().startsWith('[') },
    // Non-empty required: an Ashby board literally named `jobs` EXISTS and is empty, returning
    // HTTP 200 `{"jobs":[],"apiVersion":"1"}`. Any company whose careers host starts with `jobs.`
    // derives that slug, matched here, and detection stopped with a board that has nothing in it.
    {
      ats: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      ok: (r, b) => {
        if (!r.ok) return false;
        try {
          const j = JSON.parse(b) as { jobs?: unknown[] };
          return Array.isArray(j.jobs) && j.jobs.length > 0;
        } catch {
          return false;
        }
      },
    },
    // SmartRecruiters needs a NON-EMPTY check, unlike the other four.
    //
    // Its API answers HTTP 200 for ANY slug — a made-up `definitely-not-a-real-company-xyz987`
    // returns `{"offset":0,"limit":100,"totalFound":0,"content":[]}`. Matching on the mere presence
    // of `"content"`/`"totalFound"` therefore succeeded for every company on earth, so `detectAts`
    // reported `smartrecruiters` for anything not already on Greenhouse/Lever/Ashby/Recruitee —
    // including Epic, Mayo Clinic and Kaiser Permanente, none of which are on it. Two consequences:
    // the board pull returned 0 jobs, and because an ATS had "been detected" the Playwright crawl
    // fallback never ran, so those companies contributed nothing at all.
    // Greenhouse/Lever/Ashby/Recruitee all 404 on an unknown slug (verified), so they are fine.
    {
      ats: 'smartrecruiters',
      url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
      ok: (r, b) => {
        if (!r.ok) return false;
        try {
          const j = JSON.parse(b) as { totalFound?: number; content?: unknown[] };
          return (j.totalFound ?? 0) > 0 || (Array.isArray(j.content) && j.content.length > 0);
        } catch {
          return false;
        }
      },
    },
    { ats: 'recruitee', url: `https://${slug}.recruitee.com/api/offers`, ok: (r, b) => r.ok && /"offers"\s*:/.test(b) },
    // --- probes below all require a NON-EMPTY board. An empty 200 is what caused the
    // SmartRecruiters / Ashby / Recruitee false positives, so presence-only checks are banned here.
    {
      ats: 'workable',
      url: `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
      ok: (_r, b) => nonEmptyArray(b, 'jobs'),
    },
    { ats: 'breezy', url: `https://${slug}.breezy.hr/json`, ok: (_r, b) => nonEmptyTopLevelArray(b) },
    { ats: 'pinpoint', url: `https://${slug}.pinpointhq.com/jobs.json`, ok: (_r, b) => nonEmptyArray(b, 'data') || nonEmptyTopLevelArray(b) },
    { ats: 'bamboohr', url: `https://${slug}.bamboohr.com/careers/list`, ok: (_r, b) => nonEmptyArray(b, 'result') },
    { ats: 'personio', url: `https://${slug}.jobs.personio.com/xml`, ok: (_r, b) => /<position[\s>]/i.test(b) },
    { ats: 'teamtailor', url: `https://${slug}.teamtailor.com/jobs.rss`, ok: (_r, b) => /<item[\s>]/i.test(b) },
    { ats: 'rippling', url: `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`, ok: (_r, b) => nonEmptyTopLevelArray(b) },
    { ats: 'manatal', url: `https://api.manatal.com/open/v3/career-page/${slug}/jobs/`, ok: (_r, b) => nonEmptyArray(b, 'results') },
  ];
  // Probes run in PARALLEL. They were sequential, and each `get()` carries a 12s timeout, so a
  // slug that matched nothing cost up to 60s — multiplied by up to 2 slugs per seed and 160 seeds,
  // this was the single largest contributor to the discover step (measured 27-107 min).
  // Firing all five costs 4 extra requests against unrelated public APIs and returns in the time
  // of the slowest one. Preference order is preserved by scanning the settled results in the
  // original `probes` order rather than taking whichever resolved first.
  const settled = await Promise.all(
    probes.map(async (p) => {
      const res = await get(p.url);
      if (!res) return null;
      let body = '';
      try { body = await res.text(); } catch { return null; }
      return p.ok(res, body) ? p.ats : null;
    }),
  );
  for (let i = 0; i < probes.length; i++) {
    if (settled[i]) return toMatch(probes[i].ats, slug);
  }
  return null;
}

/**
 * Detect the ATS for a company name or careers/home URL. Returns null if nothing matched
 * (caller falls back to a generic crawl). For URLs, sniffs the URL then the page HTML; for
 * names, probes derived slugs against each ATS API.
 */
export async function detectAts(input: string): Promise<AtsMatch | null> {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  if (isUrl(trimmed)) {
    // 1. URL itself may already name the ATS.
    const fromUrl = sniffString(trimmed);
    if (fromUrl) return fromUrl;
    // 2. Fetch the page and sniff embedded ATS markers (iframes, script srcs, links).
    const res = await get(trimmed);
    if (res && res.ok) {
      const html = await res.text().catch(() => '');
      const fromHtml = sniffString(html);
      if (fromHtml) return fromHtml;
    }
    // 3. Last resort: derive a slug from the host and probe.
    try {
      const host = new URL(trimmed).hostname.replace(/^www\./, '').split('.')[0];
      // A generic prefix is NOT a company identifier, and probing it attributes someone else's
      // board to this company. `jobs.recruitee.com` is a REAL Recruitee board with 9 postings, so
      // `jobs.cvshealth.com` would have imported those 9 jobs as CVS Health's. Skip the probe and
      // let the caller crawl instead.
      if (GENERIC_HOST_PREFIXES.has(host.toLowerCase())) return null;
      return await probeSlug(host);
    } catch {
      return null;
    }
  }

  // Plain company name → probe derived slugs.
  for (const slug of nameToSlugs(trimmed)) {
    const match = await probeSlug(slug);
    if (match) return match;
  }
  return null;
}
