import { NextResponse } from 'next/server';
import db from '@/lib/db';

/**
 * Counts-only endpoint for the dashboard stat tiles.
 *
 * The dashboard was fetching TWO full payloads purely to read `.length`:
 *   - `/api/digest`   — the ranked digest items, just to show "New today: N"
 *   - `/api/outcomes` — every application row with its cover letter and résumé variant blobs,
 *                       just to show "Applied: N"
 * The second is the expensive one: those rows carry multi-kilobyte generated documents, all of it
 * serialised, transferred and parsed so the UI could call `.length` on the array.
 *
 * These are cheap SQL aggregates. The full endpoints still exist for the pages that genuinely need
 * the rows (`/tracker`).
 */
export async function GET() {
  try {
    const FRESH_HOURS = parseInt(process.env.DIGEST_FRESH_HOURS || '', 10) || 48;
    const windowArg = `-${FRESH_HOURS} hours`;

    // Same predicate as /api/digest — including the GLOB guard, because `posted_at` is TEXT in
    // mixed formats and a naive string comparison mis-sorts (and would read an RFC-2822 value as
    // fresh forever). Kept in step deliberately: two different "new today" numbers is worse than
    // none.
    const fresh = db
      .prepare(
        `SELECT COUNT(*) c FROM job_postings
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
      .get(windowArg, windowArg) as { c: number };

    const applied = db.prepare('SELECT COUNT(*) c FROM my_applications').get() as { c: number };

    return NextResponse.json({
      freshCount: fresh.c,
      appliedCount: applied.c,
      windowHours: FRESH_HOURS,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  }
}
