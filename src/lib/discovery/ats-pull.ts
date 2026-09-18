// ATS pull — fetch and normalize a company's whole job board from a detected ATS.
// Reuses the same public endpoints the per-source ingest scripts use. No import side effects.

import type { AtsMatch } from './ats-detect';
import { parseWorkdaySlug } from './ats-detect';

export interface NormalizedJob {
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  posted_at: string | null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function stripHtml(html: string | null | undefined): string {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJson(url: string, timeoutMs = 15000): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const SR_DETAIL_CAP = 40; // bound SmartRecruiters per-posting detail fetches

/**
 * Pull all jobs for a detected ATS board, normalized. `displayName` is used as the company
 * label (falls back to the slug). Returns [] on any failure (never throws).
 */
export async function pullBoard(match: AtsMatch, displayName?: string): Promise<NormalizedJob[]> {
  const company = displayName || match.slug;
  try {
    switch (match.ats) {
      case 'greenhouse': return await pullGreenhouse(match.slug, company);
      case 'lever': return await pullLever(match.slug, company);
      case 'ashby': return await pullAshby(match.slug, company);
      case 'recruitee': return await pullRecruitee(match.slug, company);
      case 'smartrecruiters': return await pullSmartRecruiters(match.slug, company);
      case 'workday': return await pullWorkday(match.slug, company);
      case 'workable': return await pullWorkable(match.slug, company);
      case 'breezy': return await pullBreezy(match.slug, company);
      case 'pinpoint': return await pullPinpoint(match.slug, company);
      case 'bamboohr': return await pullBambooHr(match.slug, company);
      case 'personio': return await pullPersonio(match.slug, company);
      case 'teamtailor': return await pullTeamtailor(match.slug, company);
      case 'rippling': return await pullRippling(match.slug, company);
      case 'manatal': return await pullManatal(match.slug, company);
    }
  } catch {
    return [];
  }
}


/**
 * Workday boards, via the same JSON endpoint the careers page itself calls.
 *
 * `POST /wday/cxs/{tenant}/{site}/jobs` with `{appliedFacets, limit, offset, searchText}` returns
 * `{total, jobPostings:[{title, externalPath, locationsText, postedOn}]}`. Detail comes from
 * `GET /wday/cxs/{tenant}/{site}{externalPath}` as `{jobPostingInfo:{jobDescription, ...}}`.
 *
 * WHY THIS IS URL-ONLY: the tenant, data-centre host and site name cannot be derived from a company
 * name. Probing 15 plausible combinations for Kaiser, HCA, Providence, Cigna and Elevance produced
 * zero working boards. So a Workday company must be seeded as its real careers URL (the one in the
 * address bar when you land on their Workday board), and `detectAts` extracts the three parts.
 *
 * Workday paginates at 20 per page regardless of `limit`, so this walks pages until it has
 * everything or hits the cap. `descriptions` are fetched for the first N only — a big board would
 * otherwise be hundreds of extra requests, and the matcher works from title + whatever text exists.
 */
const WORKDAY_PAGE = 20;
const WORKDAY_MAX_JOBS = 400;
const WORKDAY_MAX_DETAILS = 60;
const WORKDAY_PAGE_DELAY_MS = 400;

async function pullWorkday(slug: string, company: string): Promise<NormalizedJob[]> {
  const wd = parseWorkdaySlug(slug);
  if (!wd) return [];

  // Derive a readable company name from the tenant when the caller had none.
  //
  // Workday seeds are URLs, so `pullBoard`'s `displayName || match.slug` fallback attributed every
  // job to the literal "genpact.wd108.myworkdayjobs.com/External_Careers". That is not cosmetic:
  // the UI groups and caps results per company, and the duplicate-collapsing key is company+title,
  // so a URL-as-company breaks both.
  const looksLikeUrl = /myworkdayjobs\.com/i.test(company);
  const displayCompany = looksLikeUrl
    // \b\w — the FIRST letter of each word. Without the word boundary this uppercased every
    // character, turning "genpact" into "GENPACT".
    ? wd.tenant.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : company;
  const api = `https://${wd.host}/wday/cxs/${wd.tenant}/${wd.site}`;

  const postings: Array<{ title?: string; externalPath?: string; locationsText?: string; postedOn?: string }> = [];
  for (let offset = 0; offset < WORKDAY_MAX_JOBS; offset += WORKDAY_PAGE) {
    let page: { total?: number; jobPostings?: typeof postings } | null = null;
    try {
      const res = await fetch(`${api}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText: '' }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) break;
      page = (await res.json()) as { total?: number; jobPostings?: typeof postings };
    } catch {
      break;
    }
    const batch = page?.jobPostings ?? [];
    postings.push(...batch);
    if (batch.length < WORKDAY_PAGE) break;
    // Pause between pages. Workday tenants throttle rapid pagination: Humana, Centene and Cigna all
    // stopped returning rows after exactly two pages, and a follow-up probe of the same endpoint
    // returned 0 for every offset — i.e. the tenant had started refusing us, not run out of jobs.
    // Cleveland Clinic (which we hit less hard) paged all the way to the 400 cap. This is the same
    // per-host courtesy the ingest scripts keep.
    await new Promise((r) => setTimeout(r, WORKDAY_PAGE_DELAY_MS));
    if (page?.total != null && postings.length >= page.total) break;
  }

  const out: NormalizedJob[] = [];
  for (let i = 0; i < postings.length; i++) {
    const jp = postings[i];
    if (!jp.title || !jp.externalPath) continue;
    // The externalPath already begins with '/'.
    const jobUrl = `https://${wd.host}/${wd.site}${jp.externalPath}`;
    let description = '';
    if (i < WORKDAY_MAX_DETAILS) {
      try {
        const d = await fetch(`${api}${jp.externalPath}`, {
          headers: { Accept: 'application/json', 'User-Agent': UA },
          signal: AbortSignal.timeout(20_000),
        });
        if (d.ok) {
          const dj = (await d.json()) as { jobPostingInfo?: { jobDescription?: string } };
          description = (dj.jobPostingInfo?.jobDescription || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 8000);
        }
      } catch {
        /* description is optional — keep the posting */
      }
    }
    out.push({
      title: jp.title,
      company: displayCompany,
      location: jp.locationsText || '',
      description,
      url: jobUrl,
      posted_at: null, // Workday's `postedOn` is relative text ("Posted 3 Days Ago"), not a date
    });
  }
  return out;
}


/** Fetch as text — for the boards that publish RSS/XML rather than JSON. */
async function getText(url: string, timeoutMs = 20000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,application/rss+xml,*/*' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip tags/entities from an XML or HTML fragment. */
function textOf(xml: string): string {
  return xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull the first value of `<tag>…</tag>` out of an XML block. */
function xmlTag(block: string, tag: string): string {
  // NB the doubled backslashes: this is a TEMPLATE LITERAL, so `\s` would collapse to a literal
  // "s" before RegExp ever sees it — the class became `[sS]` and matched only those two letters,
  // which is why every XML feed silently parsed to zero jobs.
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? textOf(m[1]) : '';
}

/** Split an XML document into repeated `<tag>` blocks. */
function xmlBlocks(xml: string, tag: string): string[] {
  return xml.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi')) || [];
}


// ---------------------------------------------------------------------------
// Additional ATS boards.
//
// Every adapter below was verified against a REAL, KNOWN-LIVE tenant before being written — see
// `.notes/scripts/probe-all-ats.ts`, which reports the job COUNT each endpoint returned rather than
// just its HTTP status. That discipline exists because three separate false-positive bugs in
// `ats-detect.ts` all came from trusting a 200 response.
// ---------------------------------------------------------------------------

/** Workable — verified: `1000heads` returned 18 jobs. */
async function pullWorkable(slug: string, company: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
  const jobs = data?.jobs || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jobs.map((j: any): NormalizedJob => ({
    title: j.title || '',
    company: data?.name || company,
    location: [j.city, j.state, j.country].filter(Boolean).join(', '),
    description: stripHtml(j.description),
    url: j.url || j.shortlink || `https://apply.workable.com/${slug}/j/${j.shortcode}`,
    posted_at: j.published_on || j.created_at || null,
  }));
}

/** Breezy HR — verified: `1-grid` returned 9 jobs. */
async function pullBreezy(slug: string, company: string): Promise<NormalizedJob[]> {
  const jobs = await getJson(`https://${slug}.breezy.hr/json`);
  if (!Array.isArray(jobs)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jobs.map((j: any): NormalizedJob => ({
    title: j.name || j.title || '',
    company,
    location:
      j.location?.name || [j.location?.city, j.location?.country].filter(Boolean).join(', ') || '',
    description: stripHtml(j.description),
    url: j.url || `https://${slug}.breezy.hr/p/${j.id}`,
    posted_at: j.published_date || j.creation_date || null,
  }));
}

/** Pinpoint — verified: `accenture` returned 3 jobs. */
async function pullPinpoint(slug: string, company: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://${slug}.pinpointhq.com/jobs.json`);
  const jobs = Array.isArray(data) ? data : data?.data || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jobs.map((j: any): NormalizedJob => ({
    title: j.title || '',
    company,
    location: j.location?.name || (typeof j.location === 'string' ? j.location : '') || '',
    description: stripHtml(j.description || j.content),
    url: j.url || (j.path ? `https://${slug}.pinpointhq.com${j.path}` : ''),
    posted_at: j.published_at || j.created_at || null,
  }));
}

/**
 * BambooHR — verified: `1010games` returned 4 jobs.
 *
 * The list endpoint carries no job body. Fetching one detail request per posting would multiply the
 * request count across a whole discover run, and the matcher scores from the title plus whatever
 * text exists, so the description is deliberately left empty here.
 */
async function pullBambooHr(slug: string, company: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://${slug}.bamboohr.com/careers/list`);
  const jobs = data?.result || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jobs.map((j: any): NormalizedJob => ({
    title: j.jobOpeningName || j.title?.label || (typeof j.title === 'string' ? j.title : '') || '',
    company: data?.meta?.companyName || company,
    location:
      [j.location?.city, j.location?.state, j.location?.country].filter(Boolean).join(', ') ||
      j.atsLocation?.label ||
      '',
    description: '',
    url: `https://${slug}.bamboohr.com/careers/${j.id}`,
    posted_at: null,
  }));
}

/** Personio — verified: `1nce` returned 12 positions. XML feed, not JSON. */
async function pullPersonio(slug: string, company: string): Promise<NormalizedJob[]> {
  const xml = await getText(`https://${slug}.jobs.personio.com/xml`);
  if (!xml) return [];
  return xmlBlocks(xml, 'position').map((b): NormalizedJob => {
    const id = xmlTag(b, 'id');
    return {
      title: xmlTag(b, 'name'),
      company,
      location: xmlTag(b, 'office') || xmlTag(b, 'city'),
      description: [xmlTag(b, 'jobDescriptions'), xmlTag(b, 'description')]
        .filter(Boolean)
        .join(' ')
        .slice(0, 8000),
      url: id ? `https://${slug}.jobs.personio.com/job/${id}` : `https://${slug}.jobs.personio.com/`,
      posted_at: xmlTag(b, 'createdAt') || null,
    };
  });
}

/** Teamtailor — verified: `ramirent` returned 10 jobs. RSS feed. */
async function pullTeamtailor(slug: string, company: string): Promise<NormalizedJob[]> {
  const xml = await getText(`https://${slug}.teamtailor.com/jobs.rss`);
  if (!xml) return [];
  return xmlBlocks(xml, 'item').map((b): NormalizedJob => ({
    title: xmlTag(b, 'title'),
    company,
    location: xmlTag(b, 'location') || xmlTag(b, 'category'),
    description: xmlTag(b, 'description').slice(0, 8000),
    url: xmlTag(b, 'link'),
    posted_at: xmlTag(b, 'pubDate') || null,
  }));
}

/** Rippling — verified: `aalo-atomics` returned 66 jobs. */
async function pullRippling(slug: string, company: string): Promise<NormalizedJob[]> {
  const jobs = await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`);
  if (!Array.isArray(jobs)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jobs.map((j: any): NormalizedJob => ({
    title: j.name || j.title || '',
    company,
    location: j.workLocation?.label || (typeof j.location === 'string' ? j.location : '') || '',
    description: stripHtml(j.jobDescription || j.description),
    url: j.url || j.applicationUrl || '',
    posted_at: j.createdAt || null,
  }));
}

/** Manatal — verified: `1010-solutions` returned 4 jobs. */
async function pullManatal(slug: string, company: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://api.manatal.com/open/v3/career-page/${slug}/jobs/`);
  const jobs = data?.results || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jobs.map((j: any): NormalizedJob => ({
    title: j.position_name || j.title || '',
    company: j.organization_name || company,
    location:
      [j.city, j.country].filter(Boolean).join(', ') ||
      (typeof j.location === 'string' ? j.location : '') ||
      '',
    description: stripHtml(j.description),
    // Manatal's API exposes only `id`/`hash`; the public posting lives on its shared board host.
    url: j.hash ? `https://www.careers-page.com/${slug}/job/${j.hash}` : `https://www.careers-page.com/${slug}`,
    posted_at: j.created_at || null,
  }));
}

async function pullGreenhouse(slug: string, company: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  const jobs = data?.jobs || [];
  return jobs.map((j: any): NormalizedJob => ({
    title: j.title || '',
    company,
    location: j.location?.name || '',
    description: stripHtml(j.content || ''),
    url: j.absolute_url || '',
    posted_at: j.updated_at || null,
  }));
}

async function pullLever(slug: string, company: string): Promise<NormalizedJob[]> {
  const jobs = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j: any): NormalizedJob => ({
    title: j.text || '',
    company,
    location: j.categories?.location || '',
    description: stripHtml(j.descriptionPlain || j.description || ''),
    url: j.hostedUrl || j.applyUrl || '',
    posted_at: j.createdAt ? safeIso(j.createdAt) : null,
  }));
}

async function pullAshby(slug: string, company: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  const jobs = data?.jobs || [];
  return jobs.map((j: any): NormalizedJob => ({
    title: j.title || '',
    company,
    location: j.location || '',
    description: stripHtml(j.descriptionHtml || j.descriptionPlain || ''),
    url: j.jobUrl || j.applyUrl || '',
    posted_at: j.publishedDate || null,
  }));
}

async function pullRecruitee(slug: string, company: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://${slug}.recruitee.com/api/offers`);
  const offers = data?.offers || [];
  return offers.map((o: any): NormalizedJob => ({
    title: o.title || '',
    company,
    location: [o.city, o.country].filter(Boolean).join(', ') || o.location || '',
    description: stripHtml(o.description || ''),
    url: o.careers_url || o.careers_apply_url || '',
    posted_at: o.published_at || null,
  }));
}

async function pullSmartRecruiters(slug: string, company: string): Promise<NormalizedJob[]> {
  const data = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
  const postings = data?.content || [];
  const out: NormalizedJob[] = [];
  for (let i = 0; i < postings.length; i++) {
    const p = postings[i];
    let description = '';
    if (i < SR_DETAIL_CAP && p.id) {
      const detail = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${p.id}`);
      const sections = detail?.jobAd?.sections;
      if (sections) {
        description = stripHtml(
          [sections.jobDescription?.text, sections.qualifications?.text, sections.additionalInformation?.text]
            .filter(Boolean).join(' ')
        );
      }
    }
    out.push({
      title: p.name || '',
      company,
      location: [p.location?.city, p.location?.country].filter(Boolean).join(', '),
      description,
      url: p.applyUrl || p.ref || '',
      posted_at: p.releasedDate || null,
    });
  }
  return out;
}

function safeIso(v: number | string): string | null {
  try {
    const d = new Date(typeof v === 'number' ? v : Date.parse(v));
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  } catch {
    return null;
  }
}
