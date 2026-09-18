import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { fetchAmbitionbox, findRelevantSalary, type AmbitionboxData } from '@/lib/ambitionbox';

interface Row {
  company_slug: string;
  ambitionbox_slug: string | null;
  company_name: string | null;
  hq: string | null;
  industry: string | null;
  employee_band: string | null;
  followers_count: number | null;
  overall_rating: number | null;
  industry_rating: number | null;
  total_reviews: number | null;
  work_life: number | null;
  company_culture: number | null;
  compensation_benefits: number | null;
  career_growth: number | null;
  job_security: number | null;
  work_satisfaction: number | null;
  skill_development: number | null;
  last_updated_at: string | null;
  salaries_json: string | null;
  reviews_json: string | null;
  source_url: string | null;
  fetched_at: string;
  not_found: number | null;
}

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// A negative result (no Ambitionbox page) is cached for this long before we re-check.
const NEG_TTL_MS = 14 * 86_400_000;
function withinTtl(fetchedAt: string, ttlMs: number): boolean {
  const t = new Date(fetchedAt.replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(t) && Date.now() - t < ttlMs;
}

function rowToData(r: Row): AmbitionboxData {
  return {
    companySlug: r.company_slug,
    ambitionboxSlug: r.ambitionbox_slug || r.company_slug,
    companyName: r.company_name || r.company_slug,
    hq: r.hq,
    industry: r.industry,
    employeeBand: r.employee_band,
    followersCount: r.followers_count || 0,
    ratings: {
      overall: r.overall_rating || 0,
      compensationBenefits: r.compensation_benefits || 0,
      skillDevelopment: r.skill_development || 0,
      companyCulture: r.company_culture || 0,
      workLife: r.work_life || 0,
      workSatisfaction: r.work_satisfaction || 0,
      careerGrowth: r.career_growth || 0,
      jobSecurity: r.job_security || 0,
      totalReviews: r.total_reviews || 0,
      industryRating: r.industry_rating,
      lastUpdatedAt: r.last_updated_at,
    },
    salaries: r.salaries_json ? JSON.parse(r.salaries_json) : [],
    reviewSamples: r.reviews_json ? JSON.parse(r.reviews_json) : [],
    sourceUrl: r.source_url || '',
  };
}

// POST /api/companies/[slug]/ambitionbox?refresh=1 — lazy-on-view cache.
// Body: { role_hint?: string } → returns role-matched salary too.
export async function POST(req: NextRequest, props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  try {
    const slug = normalizeSlug(params.slug);
    if (!slug) return NextResponse.json({ error: 'Invalid slug' }, { status: 400 });

    const url = new URL(req.url);
    const force = url.searchParams.get('refresh') === '1';
    // cacheOnly: serve cached data (or null) without ever scraping Ambitionbox.
    const cacheOnly = url.searchParams.get('cacheOnly') === '1';
    const body = await req.json().catch(() => ({}));
    const roleHint: string = (body.role_hint || '').toString();

    if (!force) {
      const cached = db
        .prepare('SELECT * FROM ambitionbox_data WHERE company_slug = ?')
        .get(slug) as Row | undefined;
      if (cached && cached.not_found) {
        // Known-empty. Honor within TTL; if expired, fall through to re-scrape (unless cacheOnly).
        if (cacheOnly || withinTtl(cached.fetched_at, NEG_TTL_MS)) {
          return NextResponse.json({ data: null, roleSalary: null, cached: true, error: 'No Ambitionbox page for this slug' });
        }
      } else if (cached) {
        const data = rowToData(cached);
        const roleSalary = roleHint ? findRelevantSalary(data, roleHint) : null;
        return NextResponse.json({ data, roleSalary, cached: true });
      }
    }

    // No usable cache. In cacheOnly mode we stop here rather than scraping.
    if (cacheOnly) {
      return NextResponse.json({ data: null, roleSalary: null, cached: false });
    }

    const data = await fetchAmbitionbox(slug);
    if (!data) {
      // Cache the negative result (not_found=1) so we don't re-scrape every view for TTL.
      db.prepare(
        `INSERT INTO ambitionbox_data (company_slug, not_found, fetched_at)
         VALUES (?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(company_slug) DO UPDATE SET not_found = 1, fetched_at = CURRENT_TIMESTAMP`,
      ).run(slug);
      return NextResponse.json(
        { data: null, roleSalary: null, cached: false, error: 'No Ambitionbox page for this slug' },
        { status: 200 },
      );
    }

    db.prepare(
      `INSERT INTO ambitionbox_data
        (company_slug, ambitionbox_slug, company_name, hq, industry, employee_band, followers_count,
         overall_rating, industry_rating, total_reviews,
         work_life, company_culture, compensation_benefits, career_growth, job_security,
         work_satisfaction, skill_development, last_updated_at,
         salaries_json, reviews_json, source_url, not_found, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?,
               ?, ?, ?, ?, ?,
               ?, ?, ?,
               ?, ?, ?, 0, CURRENT_TIMESTAMP)
       ON CONFLICT(company_slug) DO UPDATE SET
         ambitionbox_slug = excluded.ambitionbox_slug,
         company_name = excluded.company_name,
         hq = excluded.hq,
         industry = excluded.industry,
         employee_band = excluded.employee_band,
         followers_count = excluded.followers_count,
         overall_rating = excluded.overall_rating,
         industry_rating = excluded.industry_rating,
         total_reviews = excluded.total_reviews,
         work_life = excluded.work_life,
         company_culture = excluded.company_culture,
         compensation_benefits = excluded.compensation_benefits,
         career_growth = excluded.career_growth,
         job_security = excluded.job_security,
         work_satisfaction = excluded.work_satisfaction,
         skill_development = excluded.skill_development,
         last_updated_at = excluded.last_updated_at,
         salaries_json = excluded.salaries_json,
         reviews_json = excluded.reviews_json,
         source_url = excluded.source_url,
         not_found = 0,
         fetched_at = CURRENT_TIMESTAMP`,
    ).run(
      data.companySlug,
      data.ambitionboxSlug,
      data.companyName,
      data.hq,
      data.industry,
      data.employeeBand,
      data.followersCount,
      data.ratings.overall,
      data.ratings.industryRating,
      data.ratings.totalReviews,
      data.ratings.workLife,
      data.ratings.companyCulture,
      data.ratings.compensationBenefits,
      data.ratings.careerGrowth,
      data.ratings.jobSecurity,
      data.ratings.workSatisfaction,
      data.ratings.skillDevelopment,
      data.ratings.lastUpdatedAt,
      JSON.stringify(data.salaries),
      JSON.stringify(data.reviewSamples),
      data.sourceUrl,
    );

    const roleSalary = roleHint ? findRelevantSalary(data, roleHint) : null;
    return NextResponse.json({ data, roleSalary, cached: false });
  } catch (error) {
    console.error('Ambitionbox lookup error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  }
}
