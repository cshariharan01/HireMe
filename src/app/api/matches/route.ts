import { NextResponse } from 'next/server';
import { buildMatchesPage, defaultPageLimit } from '@/lib/matches-page';

// GET /api/matches — the ranked match list. The heavy hybrid retrieval + re-rank lives in
// src/lib/matches.ts behind a signature-keyed read-through cache; the page/filter/facet assembly
// lives in src/lib/matches-page.ts so the SERVER-RENDERED first paint can build the identical
// payload without going through HTTP. This route now only parses query params.
//
// WHY FILTERING IS SERVER-SIDE: it used to happen in the browser, over the 30 rows that had been
// fetched, out of a 500-row pool, out of ~7,000 active jobs — a 0.42% window. That is why most
// filter chips rendered disabled ("Visa 0", "US city 0") and why the filters felt decorative.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const norm = (v: string | null): string | null => (v && v !== 'all' ? v : null);
    const envLimit = defaultPageLimit();

    const payload = buildMatchesPage({
      includeHidden: url.searchParams.get('include_hidden') === '1',
      includeExpired: url.searchParams.get('include_expired') === '1',
      // Applied jobs are excluded by default — they live in /tracker. include_applied=1 opts back in.
      includeApplied: url.searchParams.get('include_applied') === '1',
      refresh: url.searchParams.get('refresh') === '1',
      limit: Math.min(Math.max(parseInt(url.searchParams.get('limit') || String(envLimit), 10) || envLimit, 1), 200),
      offset: Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0),
      // applyScoreFilter: read apply_mode from user_settings and apply the threshold automatically.
      // Pass apply_score_filter=0 to bypass (e.g. for the Tracker view).
      applyScoreFilter: url.searchParams.get('apply_score_filter') !== '0',
      filters: {
        badge: norm(url.searchParams.get('badge')),
        place: norm(url.searchParams.get('place')),
        archetype: norm(url.searchParams.get('archetype')),
        evaluation: norm(url.searchParams.get('eval')),
        platform: norm(url.searchParams.get('platform')),
        q: (url.searchParams.get('q') || '').trim().toLowerCase() || null,
      },
    });

    return NextResponse.json(payload);
  } catch (error) {
    console.error('Match error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to compute matches' },
      { status: 500 }
    );
  }
}

