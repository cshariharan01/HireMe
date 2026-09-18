// Shared freshness/validity helpers for ingestion scripts (Phase 1).
//
// Safe to import from scripts: every function takes an already-open better-sqlite3
// handle and only touches job_postings via ALTER/UPDATE — none of the auto-schema
// side effects that importing `src/lib/db.ts` would trigger (see CLAUDE.md).
//
// Why here and not in each script: the 6 freshness columns and the "mark absent"
// pre-pass are identical across all 13 scripts. Duplicating the *schema/ontology*
// is deliberate (CJS side-effect avoidance); duplicating pure db-handle utilities is
// not — a no-side-effect helper keeps them in sync.

import type Database from 'better-sqlite3';

const FRESHNESS_COLUMNS: string[] = [
  'last_seen_at DATETIME',
  'posted_at TEXT',
  'source_present INTEGER DEFAULT 1',
  'url_status TEXT',
  'url_checked_at DATETIME',
  'expired_at DATETIME',
];

/** Idempotently add the freshness columns to job_postings (swallows "duplicate column"). */
export function ensureFreshnessColumns(db: Database.Database): void {
  for (const spec of FRESHNESS_COLUMNS) {
    try {
      db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`);
    } catch (e) {
      if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
    }
  }
}

/**
 * Before re-ingesting a source, mark all its existing rows as not-yet-seen this run.
 * Re-seeing a row flips source_present back to 1 (via the upsert). Any left at 0 after
 * the run have been delisted at source — `prune-stale.ts` retires them.
 */
export function markSourceAbsent(db: Database.Database, source: string): void {
  db.prepare('UPDATE job_postings SET source_present = 0 WHERE source = ?').run(source);
}

/**
 * Normalise any posting date to ISO-8601, or null when it can't be parsed.
 *
 * WHY THIS MATTERS: `posted_at` is a TEXT column and sources disagree about format. RSS feeds
 * (We Work Remotely) emit RFC-2822 — "Mon, 13 May 2024 03:14:30 +0000" — while most sources emit
 * ISO-8601. Anything comparing the column as TEXT then breaks: prune's posting-age rule uses a
 * lexicographic date compare (correct and index-friendly for ISO-8601), and "Mon, 13 May 2024"
 * sorts by the letter M. Measured before this existed: 213 WWR rows unusable by the age rule,
 * including a 2024 posting that should have been retired.
 *
 * Storing ISO-8601 for everything makes the text compare valid for every row.
 */
export function normalizePostedAt(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Already ISO-8601 (date or datetime): keep as-is so we don't churn existing values.
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

/**
 * One-time repair of rows already stored in a non-ISO format. Idempotent and cheap (it only
 * touches rows whose value does not start with a 4-digit year), so it is safe to call on every
 * ingest run.
 */
export function normalizeStoredPostedAt(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT id, posted_at FROM job_postings
       WHERE posted_at IS NOT NULL AND posted_at <> '' AND posted_at NOT GLOB '[0-9][0-9][0-9][0-9]-*'`,
    )
    .all() as Array<{ id: number; posted_at: string }>;
  if (rows.length === 0) return 0;
  const upd = db.prepare('UPDATE job_postings SET posted_at = ? WHERE id = ?');
  const run = db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      const iso = normalizePostedAt(r.posted_at);
      if (iso) {
        upd.run(iso, r.id);
        n++;
      }
    }
    return n;
  });
  return run();
}
