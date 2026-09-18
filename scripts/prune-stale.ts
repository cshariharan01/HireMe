// prune-stale.ts — retire jobs that are no longer genuine/valid.
//
// A job is retired (expired_at set) when ANY of:
//   1. It hasn't been re-seen at its source for STALE_DAYS (default 21). last_seen_at is
//      refreshed every ingest run; a job that stops appearing ages out. We use
//      COALESCE(last_seen_at, ingested_at) so pre-freshness rows (last_seen_at NULL) fall
//      back to their first-seen date — correct, since those really are old.
//   2. The POSTING itself is older than MAX_POST_AGE_DAYS (default 180) per `posted_at`,
//      regardless of whether the source still lists it. REQUIRED because rule 1 alone can
//      never retire a re-listed archive: HN's "Who is hiring" threads are permanent, so
//      ingest keeps refreshing last_seen_at on 2015-2020 comments and they stay live forever.
//      (Measured before this rule existed: 390 HN rows from 2015-2020, 0% expired.)
//      Only applies where posted_at is known — 41% of rows have none, so it is not a
//      substitute for rule 1.
//   3. A live URL check (verify-links.ts) marked url_status = 'dead'.
//
// Design choice: expiry keys off last_seen_at AGE, not source_present alone. If a source
// run fails or gets blocked (e.g. Naukri/LinkedIn), markSourceAbsent flips all its rows to
// source_present=0 — expiring on that alone would wipe the whole source. Age is robust: one
// missed run doesn't matter; only persistent absence retires a job.
//
// MASS-EXPIRY GUARD: when the age rules would retire more than MAX_EXPIRY_RATIO of the active
// corpus, that means ingest did not run (or failed) — not that every job died. The QUICK sync
// mode is exactly this case: QUICK = ['embed','prune','verify:links'] has no ingest step, so
// after a few idle weeks a quick sync would expire EVERYTHING and leave 0 matches. We refuse
// and say so instead. Override with PRUNE_FORCE=1 once you have read the message.
//
// Retirement is reversible: a later ingest that re-sees the job clears expired_at (see the
// "resurrect" pass) and refreshes last_seen_at, so it returns to the match list.
//
// PURGE (opt-in, destructive): set PRUNE_PURGE_DAYS=N to permanently DELETE rows that have
// been expired for more than N days, then VACUUM. Tombstones are not free — they carry their
// description + 3 KB embedding each. Off by default because deletion is irreversible.
//
// Run: npx ts-node scripts/prune-stale.ts   (part of `npm run daily`)

import Database from 'better-sqlite3';
import path from 'path';
import { normalizeStoredPostedAt } from './shared/freshness';

const STALE_DAYS = parseInt(process.env.STALE_DAYS || '21', 10) || 21;
const MAX_POST_AGE_DAYS = parseInt(process.env.MAX_POST_AGE_DAYS || '180', 10) || 180;
// Fraction of the active corpus the age rules may retire in one run before we treat it as a
// pipeline failure rather than genuine churn. 0.4 = "more than 40% is not churn".
const MAX_EXPIRY_RATIO = parseFloat(process.env.MAX_EXPIRY_RATIO || '0.4') || 0.4;
const FORCE = process.env.PRUNE_FORCE === '1';
const PURGE_DAYS = parseInt(process.env.PRUNE_PURGE_DAYS || '0', 10) || 0;

// HIRESIGNAL_DB lets you point this at a COPY of the database. Do that before trusting any
// change to the expiry rules: `HIRESIGNAL_DB=/tmp/copy.db npx ts-node scripts/prune-stale.ts`.
const DB_PATH = process.env.HIRESIGNAL_DB || path.join(process.cwd(), 'data', 'hiresignal.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Per-connection, so db.ts's setting never reaches this script. NORMAL is safe under WAL and
// these are full-table UPDATEs.
db.pragma('synchronous = NORMAL');
// REQUIRED once ingest sources run concurrently: WAL allows one writer at a time, and without
// a busy timeout a second writer fails immediately with SQLITE_BUSY instead of waiting its turn.
db.pragma('busy_timeout = 15000');

// Ensure columns exist even if the app hasn't booted yet (fresh checkout / script-first run).
for (const spec of ['last_seen_at DATETIME', 'source_present INTEGER DEFAULT 1', 'url_status TEXT', 'expired_at DATETIME', 'posted_at TEXT']) {
  try { db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`); }
  catch (e) { if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e; }
}

// Repair any posted_at stored in a non-ISO format BEFORE the age rule reads the column. RSS
// sources emit RFC-2822 ("Mon, 13 May 2024 ..."), and the age rule below compares dates as TEXT —
// which is correct for ISO-8601 and meaningless for anything else. Idempotent and cheap.
const normalized = normalizeStoredPostedAt(db);

const cutoff = `-${STALE_DAYS} days`;
const postCutoff = `-${MAX_POST_AGE_DAYS} days`;

const count = (sql: string, ...params: unknown[]): number =>
  (db.prepare(`SELECT COUNT(*) n FROM job_postings WHERE ${sql}`).get(...params) as { n: number }).n;

// 1. Resurrect: any job that was re-seen after being retired comes back. Runs first and is
//    never guarded — bringing jobs back is always safe.
const resurrected = db.prepare(`
  UPDATE job_postings
  SET expired_at = NULL
  WHERE expired_at IS NOT NULL
    AND url_status IS NOT 'dead'
    AND COALESCE(last_seen_at, ingested_at) >= datetime('now', ?)
    AND (posted_at IS NULL OR posted_at >= datetime('now', ?))
`).run(cutoff, postCutoff);

// --- the two age predicates, shared between the dry-run count and the UPDATEs ---
const STALE_PRED = `expired_at IS NULL AND COALESCE(last_seen_at, ingested_at) < datetime('now', ?)`;
// posted_at is stored in mixed formats (ISO-8601 with Z from most sources, plain datetime from
// others). Comparing as text works for both because ISO-8601 sorts lexicographically, but a
// bare date like '2015-07-01' also compares correctly against '2026-03-01 12:00:00'.
// GLOB guards the comparison: only rows whose posted_at actually starts with a 4-digit year are
// compared. Anything else (an unparseable format that normalizeStoredPostedAt could not fix) is
// left alone rather than mis-compared — a wrong comparison here EXPIRES a live job.
const OLD_POST_PRED = `expired_at IS NULL AND posted_at IS NOT NULL AND posted_at <> ''
  AND posted_at GLOB '[0-9][0-9][0-9][0-9]-*'
  AND substr(posted_at, 1, 10) < substr(datetime('now', ?), 1, 10)`;

const activeBefore = count('expired_at IS NULL');
const wouldStale = count(STALE_PRED, cutoff);
const wouldOldPost = count(OLD_POST_PRED, postCutoff);
// Union, not sum — a row can match both.
const wouldExpire = count(`(${STALE_PRED}) OR (${OLD_POST_PRED})`, cutoff, postCutoff);
const ratio = activeBefore > 0 ? wouldExpire / activeBefore : 0;

let staled = { changes: 0 };
let oldPost = { changes: 0 };
let guardTripped = false;

if (activeBefore > 0 && ratio > MAX_EXPIRY_RATIO && !FORCE) {
  guardTripped = true;
} else {
  // 2. Expire stale: not re-seen within STALE_DAYS.
  staled = db.prepare(`UPDATE job_postings SET expired_at = datetime('now') WHERE ${STALE_PRED}`).run(cutoff);
  // 3. Expire by posting age, whatever the source still says.
  oldPost = db.prepare(`UPDATE job_postings SET expired_at = datetime('now') WHERE ${OLD_POST_PRED}`).run(postCutoff);
}

// 4. Expire dead links (verify-links marks these). Never guarded: a 404 is per-job evidence,
//    not a pipeline symptom, and the set is inherently small.
const dead = db.prepare(`
  UPDATE job_postings
  SET expired_at = datetime('now')
  WHERE expired_at IS NULL AND url_status = 'dead'
`).run();

const remaining = count('expired_at IS NULL');
const total = (db.prepare('SELECT COUNT(*) n FROM job_postings').get() as { n: number }).n;

console.log(`prune-stale (STALE_DAYS=${STALE_DAYS}, MAX_POST_AGE_DAYS=${MAX_POST_AGE_DAYS}):`);
console.log(`  resurrected (re-seen):        ${resurrected.changes}`);
if (normalized > 0) console.log(`  posted_at normalised to ISO: ${normalized}`);

if (guardTripped) {
  console.warn('');
  console.warn(`  !! SKIPPED age-based expiry — it would have retired ${wouldExpire} of ${activeBefore} active jobs (${(ratio * 100).toFixed(0)}%).`);
  console.warn(`     That means INGEST DID NOT RUN, not that every job closed. Nothing was expired.`);
  console.warn(`     Most likely: a "quick" sync (embed -> prune -> verify) with no ingest step, or`);
  console.warn(`     a long gap since the last sync (every last_seen_at is older than STALE_DAYS).`);
  console.warn(`     Fix: run a FULL sync so ingest refreshes last_seen_at first, then prune.`);
  console.warn(`     To expire anyway: PRUNE_FORCE=1 npx ts-node scripts/prune-stale.ts`);
  console.warn(`     (breakdown: ${wouldStale} not re-seen in ${STALE_DAYS}d, ${wouldOldPost} posted over ${MAX_POST_AGE_DAYS}d ago)`);
  console.warn('');
} else {
  console.log(`  expired (stale >${STALE_DAYS}d):       ${staled.changes}`);
  console.log(`  expired (posted >${MAX_POST_AGE_DAYS}d ago): ${oldPost.changes}`);
}
console.log(`  expired (dead link):          ${dead.changes}`);
console.log(`  active now: ${remaining} / ${total} total`);

// 5. PURGE (opt-in): permanently remove long-dead tombstones and reclaim the file space.
//
// ORPHANS ONLY, and the guard is DERIVED FROM THE SCHEMA rather than hand-listed.
//
// Every table that references job_postings does so with ON DELETE NO ACTION, so a blanket DELETE
// fails with SQLITE_CONSTRAINT_FOREIGNKEY and removes nothing. Two of those references are records
// we must never destroy anyway: an application is YOUR history, and an evaluation is LLM spend
// already paid for. So a row is only purged when nothing at all references it.
//
// This list USED to be hardcoded (match_results, my_applications, job_evaluations, apply_audit) and
// promptly went stale the moment `job_skills` was added — 343 purge-eligible rows had a job_skills
// row, so the DELETE raised a constraint error and rolled back the whole purge. Reading
// `PRAGMA foreign_key_list` means a future table with an FK to job_postings is covered on the day
// it lands, and a dropped table stops being referenced by dead SQL.
function referencingTables(): { table: string; column: string }[] {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  const refs: { table: string; column: string }[] = [];
  for (const { name } of tables) {
    if (name === 'job_postings') continue;
    let fks: { table: string; from: string; on_delete?: string }[] = [];
    try {
      fks = db.pragma(`foreign_key_list(${JSON.stringify(name)})`) as { table: string; from: string; on_delete?: string }[];
    } catch {
      continue; // virtual/FTS shadow tables don't answer this pragma
    }
    for (const fk of fks) {
      if (fk.table !== 'job_postings') continue;
      // Skip CASCADE refs. A cascading FK means the table is DERIVED DATA that SQLite will clean up
      // for us, so protecting rows on its behalf just makes tombstones unpurgeable forever. That
      // was measurable: `job_skills` (a pure extraction cache) held rows for 331 otherwise-orphaned
      // tombstones, dropping the purgeable set from 3,580 to 3,249. The tables we must never
      // destroy — applications, evaluations, the audit log — are all ON DELETE NO ACTION, so they
      // still protect their rows.
      if (String(fk.on_delete || '').toUpperCase() === 'CASCADE') continue;
      refs.push({ table: name, column: fk.from });
    }
  }
  return refs;
}

const REFS = referencingTables();
const ORPHAN_PRED = [
  `expired_at IS NOT NULL AND expired_at < datetime('now', ?)`,
  ...REFS.map(
    (r) => `NOT EXISTS (SELECT 1 FROM ${r.table} r WHERE r.${r.column} = job_postings.id)`,
  ),
].join('\n  AND ');

if (PURGE_DAYS > 0) {
  const purgeArg = `-${PURGE_DAYS} days`;
  console.log(`  purge guard protects rows referenced by: ${REFS.map((r) => r.table).join(', ') || '(none)'}`);
  const eligible = count(`expired_at IS NOT NULL AND expired_at < datetime('now', ?)`, purgeArg);
  const orphans = count(ORPHAN_PRED, purgeArg);
  const sizeBefore = (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number);

  const purged = db.prepare(`DELETE FROM job_postings WHERE ${ORPHAN_PRED}`).run(purgeArg);
  console.log(`  PURGED (expired >${PURGE_DAYS}d, no dependents): ${purged.changes} rows permanently deleted`);
  if (eligible > orphans) {
    console.log(`  kept ${eligible - orphans} expired row(s) that still have an application / evaluation / audit record`);
  }
  if (purged.changes > 0) {
    // VACUUM cannot run inside a transaction and needs free disk equal to the DB size.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    const sizeAfter = (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number);
    console.log(`  VACUUM done — ${(sizeBefore / 1e6).toFixed(1)}MB -> ${(sizeAfter / 1e6).toFixed(1)}MB`);
  }
} else {
  const orphans = count(ORPHAN_PRED, '-30 days');
  if (orphans > 0) {
    console.log(`  (${orphans} orphaned rows expired >30d could be purged: PRUNE_PURGE_DAYS=30 — deletion is permanent)`);
  }
}

db.close();

// Non-zero exit when the guard tripped, so the sync orchestrator surfaces it as a failed step
// rather than a silent success.
if (guardTripped) process.exitCode = 2;
