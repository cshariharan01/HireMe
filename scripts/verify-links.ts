// verify-links.ts — HTTP-check the top matches so we never surface (or apply to) dead links.
//
// Verifies the jobs the user actually sees: the top (MATCH_LIMIT * 2) ACTIVE candidates by
// cosine similarity to the resume, skipping any checked within RECHECK_HOURS. Marks
// url_status + url_checked_at; a 'dead' verdict also sets expired_at so it drops out of
// matches immediately. 'unknown' (timeouts, 403/429, 5xx) never expires a job.
//
// Run: npx ts-node scripts/verify-links.ts   (part of `npm run daily`)

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import { checkJobUrl } from '../src/lib/link-check';

const MATCH_LIMIT = parseInt(process.env.MATCH_LIMIT || '30', 10) || 30;
const VERIFY_LIMIT = Math.min(Math.max(MATCH_LIMIT * 2, 20), 300);
const RECHECK_HOURS = parseInt(process.env.LINK_RECHECK_HOURS || '24', 10) || 24;
const CONCURRENCY = 5;

const db = new Database(path.join(process.cwd(), 'data', 'hiresignal.db'));
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
// Per-connection: the NORMAL set in src/lib/db.ts does not reach a standalone script, and
// better-sqlite3 defaults to FULL — one fsync per autocommit write.
db.pragma('synchronous = NORMAL');
// REQUIRED once ingest sources run concurrently: WAL allows one writer at a time, and without
// a busy timeout a second writer fails immediately with SQLITE_BUSY instead of waiting its turn.
db.pragma('busy_timeout = 15000');

for (const spec of ['url_status TEXT', 'url_checked_at DATETIME', 'expired_at DATETIME']) {
  try { db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`); }
  catch (e) { if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e; }
}

interface JobRow { id: number; url: string; }

async function main() {
  const profile = db.prepare('SELECT embedding FROM my_profile WHERE id = 1').get() as { embedding: Buffer } | undefined;
  if (!profile?.embedding) {
    console.log('verify-links: no resume/profile embedding — upload a resume first. Skipping.');
    db.close();
    return;
  }

  const jobs = db.prepare(`
    SELECT id, url FROM job_postings
    WHERE embedding IS NOT NULL AND expired_at IS NULL AND url IS NOT NULL AND url != ''
      AND (url_checked_at IS NULL OR url_checked_at < datetime('now', ?))
    ORDER BY vec_distance_cosine(embedding, ?) ASC
    LIMIT ?
  `).all(`-${RECHECK_HOURS} hours`, profile.embedding, VERIFY_LIMIT) as JobRow[];

  console.log(`verify-links: checking ${jobs.length} top candidates (limit ${VERIFY_LIMIT}, recheck>${RECHECK_HOURS}h)...`);

  const setLive = db.prepare("UPDATE job_postings SET url_status = ?, url_checked_at = datetime('now') WHERE id = ?");
  const setDead = db.prepare("UPDATE job_postings SET url_status = 'dead', url_checked_at = datetime('now'), expired_at = datetime('now') WHERE id = ?");

  const counts = { live: 0, dead: 0, unknown: 0 };

  // Bounded concurrency to stay polite.
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const verdicts = await Promise.all(batch.map((j) => checkJobUrl(j.url)));
    batch.forEach((j, k) => {
      const verdict = verdicts[k];
      counts[verdict]++;
      if (verdict === 'dead') setDead.run(j.id);
      else setLive.run(verdict, j.id);
    });
    process.stdout.write(`\r  progress: ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length}`);
  }
  process.stdout.write('\n');

  console.log(`verify-links done: ${counts.live} live, ${counts.dead} dead (expired), ${counts.unknown} unknown.`);
  db.close();
}

main();
