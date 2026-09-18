import { NextResponse } from 'next/server';
import { getRankedMatches } from '@/lib/matches';
import db from '@/lib/db';

// GET /api/digest — the dashboard "New today / fresh" strip: the top few matches the user
// hasn't applied to yet. Reads the shared ranked-match cache (same one /api/matches uses) so
// the dashboard's two data hooks share ONE vector scan instead of running a second one here.
export async function GET() {
  try {
    const result = getRankedMatches({ includeHidden: false, includeExpired: false });
    if (!result) {
      return NextResponse.json({ error: 'No resume uploaded', items: [] });
    }

    // Actually filter by DATE — this strip is labelled "new", and it wasn't.
    //
    // It used to be "the top 5 matches" with no date condition whatsoever, so the same jobs sat
    // there indefinitely and a posting from months ago counted as "new today". Now a job qualifies
    // when it was POSTED recently, or (for the many sources that publish no date) when WE first
    // saw it recently — `posted_at` covers 843 active jobs in 48h, `ingested_at` covers 5,246, so
    // using only the former would make the strip almost empty.
    //
    // The applied-filter that used to be here was redundant: `getRankedMatches` already excludes
    // applied jobs by default (`includeApplied` opts back in), so it was re-doing work over rows
    // that could not be present.
    const FRESH_HOURS = parseInt(process.env.DIGEST_FRESH_HOURS || '', 10) || 48;
    const freshIds = new Set(
      (
        db
          .prepare(
            // `posted_at` is TEXT in MIXED formats — ISO-with-T-and-offset (6,969 rows) and bare
            // dates (80) — while `datetime()` returns "YYYY-MM-DD HH:MM:SS" with a SPACE. A direct
            // string >= comparison therefore mis-sorts at the 11th character ('T' > ' '), which
            // measurably over-counted by ~2%. Worse, an un-normalised RFC-2822 value ("Mon, 13
            // May…") compares 'M' > '2' and would read as fresh forever. Same GLOB guard +
            // day-granularity comparison that `scripts/prune-stale.ts` uses, for the same reason.
            `SELECT id FROM job_postings
             WHERE expired_at IS NULL
               AND (
                 (posted_at IS NOT NULL AND posted_at <> ''
                   AND posted_at GLOB '[0-9][0-9][0-9][0-9]-*'
                   AND substr(posted_at, 1, 10) >= substr(datetime('now', ?), 1, 10))
                 OR
                 (ingested_at IS NOT NULL
                   AND substr(ingested_at, 1, 10) >= substr(datetime('now', ?), 1, 10))
               )`,
          )
          .all(`-${FRESH_HOURS} hours`, `-${FRESH_HOURS} hours`) as Array<{ id: number }>
      ).map((r) => r.id),
    );

    const fresh = result.ranked.filter((m) => freshIds.has(m.id));

    // If genuinely nothing is new, say so with an empty list rather than quietly padding it with
    // old postings the user has already scrolled past — that padding is what made "new" meaningless.
    const items = fresh
      .slice(0, 5)
      .map((m) => ({
        id: m.id,
        company: m.company,
        title: m.title,
        location: m.location || 'Remote',
        url: m.url,
        source: m.source,
        ingestedAt: m.ingestedAt,
        score: m.finalScore,
      }));

    return NextResponse.json({
      items,
      freshCount: fresh.length,
      windowHours: FRESH_HOURS,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Digest error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}
