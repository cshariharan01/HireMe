import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { fetchLevelsCompensation, findRelevantComp, type Region, type LevelsCompData } from '@/lib/levels';

interface CompRow {
  company_slug: string;
  region: string;
  fetched_at: string;
  median_total_usd: number | null;
  currency: string | null;
  sample_count: number | null;
  source_url: string | null;
  breakdown_json: string | null;
  not_found: number | null;
}

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// A negative result (no Levels.fyi page) is cached for this long before we re-check.
const NEG_TTL_MS = 14 * 86_400_000;
function withinTtl(fetchedAt: string, ttlMs: number): boolean {
  const t = new Date(fetchedAt.replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(t) && Date.now() - t < ttlMs;
}

function rowToData(row: CompRow): LevelsCompData | null {
  try {
    return {
      companySlug: row.company_slug,
      region: row.region as Region,
      sourceUrl: row.source_url || '',
      currency: row.currency || 'USD',
      medianTotalUsd: row.median_total_usd,
      sampleCount: row.sample_count || 0,
      jobFamilies: row.breakdown_json ? JSON.parse(row.breakdown_json) : [],
    };
  } catch {
    return null;
  }
}

// POST /api/companies/[slug]/compensation?region=US|IN&refresh=1
// Body: { display_name?: string, role_hint?: string }
// Returns: { compensation: LevelsCompData | null, roleMatch?: RoleCompMatch | null, cached: boolean }
export async function POST(req: NextRequest, props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  try {
    const slug = normalizeSlug(params.slug);
    if (!slug) return NextResponse.json({ error: 'Invalid company slug' }, { status: 400 });

    const url = new URL(req.url);
    const region: Region = url.searchParams.get('region') === 'IN' ? 'IN' : 'US';
    const force = url.searchParams.get('refresh') === '1';
    // cacheOnly: serve cached data (or null) without ever scraping Levels.fyi.
    const cacheOnly = url.searchParams.get('cacheOnly') === '1';

    const body = await req.json().catch(() => ({}));
    const roleHint: string = (body.role_hint || '').toString();

    // Cache check (per company × region), including the negative marker.
    if (!force) {
      const cached = db
        .prepare('SELECT * FROM compensation_data WHERE company_slug = ? AND region = ?')
        .get(slug, region) as CompRow | undefined;
      if (cached && cached.not_found) {
        // Known-empty. Honor within TTL; if expired, fall through to re-scrape (unless cacheOnly).
        if (cacheOnly || withinTtl(cached.fetched_at, NEG_TTL_MS)) {
          return NextResponse.json({ compensation: null, roleMatch: null, cached: true, error: 'No data found on Levels.fyi' });
        }
      } else if (cached) {
        const data = rowToData(cached);
        const roleMatch = data && roleHint ? findRelevantComp(data, roleHint) : null;
        return NextResponse.json({ compensation: data, roleMatch, cached: true });
      }
    }

    // No usable cache. In cacheOnly mode we stop here rather than scraping.
    if (cacheOnly) {
      return NextResponse.json({ compensation: null, roleMatch: null, cached: false });
    }

    const data = await fetchLevelsCompensation(slug, region);
    if (!data) {
      // Cache the negative result (not_found=1) so we don't re-scrape every view for TTL.
      db.prepare(
        `INSERT INTO compensation_data (company_slug, region, not_found, breakdown_json, fetched_at)
         VALUES (?, ?, 1, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT(company_slug, region) DO UPDATE SET
           not_found = 1, breakdown_json = NULL, fetched_at = CURRENT_TIMESTAMP`,
      ).run(slug, region);
      return NextResponse.json({ compensation: null, roleMatch: null, cached: false, error: 'No data found on Levels.fyi' }, { status: 200 });
    }

    db.prepare(
      `INSERT INTO compensation_data
        (company_slug, region, median_total_usd, currency, sample_count, source_url, breakdown_json, not_found, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
       ON CONFLICT(company_slug, region) DO UPDATE SET
         median_total_usd = excluded.median_total_usd,
         currency = excluded.currency,
         sample_count = excluded.sample_count,
         source_url = excluded.source_url,
         breakdown_json = excluded.breakdown_json,
         not_found = 0,
         fetched_at = CURRENT_TIMESTAMP`,
    ).run(
      data.companySlug,
      data.region,
      data.medianTotalUsd,
      data.currency,
      data.sampleCount,
      data.sourceUrl,
      JSON.stringify(data.jobFamilies),
    );

    const roleMatch = roleHint ? findRelevantComp(data, roleHint) : null;
    return NextResponse.json({ compensation: data, roleMatch, cached: false });
  } catch (error) {
    console.error('Compensation lookup error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to look up compensation' },
      { status: 500 },
    );
  }
}
