// Ambitionbox lookup. Plain Node fetch + parse __NEXT_DATA__ JSON.
//
// Key finding: Ambitionbox blocks Playwright/chromium with HTTP/2 protocol errors,
// but plain fetch with a normal User-Agent returns 595KB of HTML cleanly. So we use
// fetch + cheerio — much faster and lighter than browser automation.
//
// Pages of interest, by URL pattern:
//   /overview/<slug>-overview     — top-line ratings + salaries digest + reviews sample
// The single overview page contains ratings, top salaries, and top reviews — enough
// to feed both the Company Brief prompt and a UI panel without scraping multiple pages.

import * as cheerio from 'cheerio';

export interface AmbitionboxRatings {
  overall: number;
  compensationBenefits: number;
  skillDevelopment: number;
  companyCulture: number;
  workLife: number;
  workSatisfaction: number;
  careerGrowth: number;
  jobSecurity: number;
  totalReviews: number;
  industryRating: number | null; // for reference comparison
  lastUpdatedAt: string | null;
}

export interface AmbitionboxSalary {
  jobTitle: string;
  minCtc: number;          // INR per year
  maxCtc: number;          // INR per year
  avgCtc: number;          // INR per year
  typicalMinCtc: number;   // typical range (excludes outliers)
  typicalMaxCtc: number;
  minExperience: number;
  maxExperience: number;
  dataPoints: number;
}

export interface AmbitionboxReviewSample {
  likes: string | null;
  dislikes: string | null;
  jobLocation: string | null;
}

export interface AmbitionboxData {
  companySlug: string;        // normalized lookup key
  ambitionboxSlug: string;    // the slug Ambitionbox uses (may differ — e.g. 'tata-consultancy-services')
  companyName: string;        // display name from page
  hq: string | null;
  industry: string | null;
  employeeBand: string | null;  // e.g. "501-1k Employees (India)"
  followersCount: number;
  ratings: AmbitionboxRatings;
  salaries: AmbitionboxSalary[];
  reviewSamples: AmbitionboxReviewSample[];
  sourceUrl: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Some companies use a different slug on Ambitionbox vs our company_slug.
// Add explicit overrides as we encounter them. Most match directly.
const SLUG_OVERRIDES: Record<string, string> = {
  'oscar': 'oscar',
  'oscar-health': 'oscar',
  'tcs': 'tata-consultancy-services',
  // (extend as we hit mismatches)
};

function ambitionboxSlug(companySlug: string): string {
  if (SLUG_OVERRIDES[companySlug]) return SLUG_OVERRIDES[companySlug];
  return companySlug;
}

interface RawJobProfile {
  jobProfileName: string;
  minCtc: string | number;
  maxCtc: string | number;
  avgCtc: string | number;
  typicalMinCtc?: string | number;
  typicalMaxCtc?: string | number;
  minExperience: string | number;
  maxExperience: string | number;
  dataPoints: string | number;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

export async function fetchAmbitionbox(companySlug: string): Promise<AmbitionboxData | null> {
  const abSlug = ambitionboxSlug(companySlug);
  const url = `https://www.ambitionbox.com/overview/${abSlug}-overview`;

  let html: string;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-IN,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (r.status !== 200) return null;
    html = await r.text();
  } catch {
    return null;
  }

  const $ = cheerio.load(html);
  const nd = $('script#__NEXT_DATA__').text();
  if (!nd) return null;

  let pp: Record<string, unknown>;
  try {
    pp = (JSON.parse(nd).props?.pageProps || {}) as Record<string, unknown>;
  } catch {
    return null;
  }

  const aggData = (pp.aggregatedRatingsData as { ratingDistribution?: { data?: Record<string, unknown> } })
    ?.ratingDistribution?.data;
  if (!aggData) return null;

  const ratingsRaw = (aggData.ratings as Record<string, number> | undefined) || {};
  const ratingsTwo = (aggData.ratingsTwoDecimal as Record<string, number> | undefined) || ratingsRaw;
  const totalReviews = num(aggData.totalCount);

  const meta = (pp.companyMetaInformation as Record<string, unknown> | undefined) || {};
  const header = (pp.companyHeaderData as Record<string, unknown> | undefined) || {};
  const infoTags =
    ((header.infoTags as Array<Record<string, unknown>> | undefined) || [])
      .map((t) => ({ name: (t.name as string) || '', type: (t.type as string) || '' }));
  const hqTag = infoTags.find((t) => t.type === 'headquarters');
  const industryTag = infoTags.find((t) => /software|product|services|finance|healthcare|consult/i.test(t.name));
  const employeeBandTag = infoTags.find((t) => /employee/i.test(t.name));

  const salariesRaw = ((pp.salariesList as { designations?: { jobProfiles?: RawJobProfile[] } })?.designations?.jobProfiles || []);
  const salaries: AmbitionboxSalary[] = salariesRaw.map((j) => ({
    jobTitle: j.jobProfileName,
    minCtc: num(j.minCtc),
    maxCtc: num(j.maxCtc),
    avgCtc: num(j.avgCtc),
    typicalMinCtc: num(j.typicalMinCtc ?? j.minCtc),
    typicalMaxCtc: num(j.typicalMaxCtc ?? j.maxCtc),
    minExperience: num(j.minExperience),
    maxExperience: num(j.maxExperience),
    dataPoints: num(j.dataPoints),
  }));

  const reviews = (pp.reviews as Array<Record<string, unknown>> | undefined) || [];
  const reviewSamples: AmbitionboxReviewSample[] = reviews.slice(0, 5).map((r) => ({
    likes: (r.likesText as string) || null,
    dislikes: (r.disLikesText as string) || null,
    jobLocation: ((r.jobLocation as { name?: string } | undefined) || {}).name || null,
  }));

  return {
    companySlug,
    ambitionboxSlug: abSlug,
    companyName: (header.companyName as string) || (meta.companyName as string) || abSlug,
    hq: hqTag?.name || null,
    industry: industryTag?.name || null,
    employeeBand: employeeBandTag?.name || null,
    followersCount: num(header.followersCount),
    ratings: {
      overall: ratingsTwo.overallCompanyRating ?? ratingsRaw.overallCompanyRating ?? 0,
      compensationBenefits: ratingsTwo.compensationBenefitsRating ?? ratingsRaw.compensationBenefitsRating ?? 0,
      skillDevelopment: ratingsTwo.skillDevelopmentRating ?? ratingsRaw.skillDevelopmentRating ?? 0,
      companyCulture: ratingsTwo.companyCultureRating ?? ratingsRaw.companyCultureRating ?? 0,
      workLife: ratingsTwo.workLifeRating ?? ratingsRaw.workLifeRating ?? 0,
      workSatisfaction: ratingsTwo.workSatisfactionRating ?? ratingsRaw.workSatisfactionRating ?? 0,
      careerGrowth: ratingsTwo.careerGrowthRating ?? ratingsRaw.careerGrowthRating ?? 0,
      jobSecurity: ratingsTwo.jobSecurityRating ?? ratingsRaw.jobSecurityRating ?? 0,
      totalReviews,
      industryRating: typeof meta.industryRating === 'number' ? meta.industryRating : null,
      lastUpdatedAt: (aggData.lastUpdatedAt as string) || null,
    },
    salaries,
    reviewSamples,
    sourceUrl: url,
  };
}

// Find the salary record most relevant to a job title. Heuristic: prefer keyword
// matches; fall back to the median-CTC entry. Returns null if no salaries.
export function findRelevantSalary(data: AmbitionboxData, jobTitle: string): AmbitionboxSalary | null {
  if (data.salaries.length === 0) return null;
  const t = (jobTitle || '').toLowerCase();
  const keywords = [
    /senior.*architect|principal.*architect|chief.*architect|solution.*architect|technical.*architect/,
    /architect/,
    /engineering manager|tech lead|team lead|lead engineer/,
    /senior software engineer|sr\.?\s*software/,
    /software engineer|developer/,
    /data engineer/,
    /devops|sre|platform engineer/,
    /product manager|pm/,
  ];
  for (const re of keywords) {
    if (!re.test(t)) continue;
    const match = data.salaries.find((s) => re.test(s.jobTitle.toLowerCase()));
    if (match) return match;
  }
  // Fallback: median-CTC entry
  const sorted = [...data.salaries].sort((a, b) => a.avgCtc - b.avgCtc);
  return sorted[Math.floor(sorted.length / 2)] || null;
}

// One-line summary for prompt injection.
export function summarizeAmbitionboxForPrompt(data: AmbitionboxData, jobTitle: string): string {
  const r = data.ratings;
  const sal = findRelevantSalary(data, jobTitle);
  const lakhs = (n: number) => `₹${(n / 100000).toFixed(1)}L`;
  const compLine = sal
    ? `${sal.jobTitle}: ${lakhs(sal.minCtc)}-${lakhs(sal.maxCtc)} (avg ${lakhs(sal.avgCtc)}, ${sal.dataPoints} reports, ${sal.minExperience}-${sal.maxExperience} yrs)`
    : 'no role-matched salary';
  const industry = r.industryRating ? ` (industry avg ${r.industryRating.toFixed(2)})` : '';
  return `Ambitionbox: ${r.totalReviews} reviews, overall ${r.overall.toFixed(1)}/5${industry}. Dimensions — work-life ${r.workLife.toFixed(1)}, culture ${r.companyCulture.toFixed(1)}, comp ${r.compensationBenefits.toFixed(1)}, career-growth ${r.careerGrowth.toFixed(1)}, job-security ${r.jobSecurity.toFixed(1)}. Salary for nearest role: ${compLine}.`;
}
