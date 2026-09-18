// ingest-all.ts — run every ingest source with bounded concurrency.
//
// WHY: `ingest:all` was 11 chained `npm run` calls (`a && b && c && …`), so every source waited for
// the one before it. Measured on the one successful full sync, the hardcoded politeness sleeps
// ALONE summed to ≥19 minutes before counting any network time, and total wall clock for the sync
// was 3h30m. The sources are independent and hit different hosts, so serialising them buys nothing.
//
// This runs them in a pool instead: total wall clock becomes roughly the SLOWEST source rather than
// the SUM of all of them. Intra-source sleeps are deliberately left alone — those are per-host
// courtesy (LinkedIn already rate-limits, hirist blocks) and cutting them risks bans, which costs
// far more than it saves.
//
// Two things this depends on:
//   - Every ingest script sets `busy_timeout` (added alongside this). SQLite WAL allows one writer
//     at a time; without a busy timeout a second concurrent writer fails instantly on SQLITE_BUSY.
//   - Each script owns its own DB connection and its own upsert, so interleaved writes are safe.
//
// A failing source is reported and does NOT abort the others — the old `&&` chain meant one blocked
// scraper (Naukri, LinkedIn) killed every source after it.
//
// Run: npx ts-node scripts/ingest-all.ts   (used by `npm run ingest:all`)
//   INGEST_CONCURRENCY=4   how many sources at once (default 4)
//   INGEST_ONLY=hn,lever   run just these (comma-separated), for testing

import './shared/env';
import { spawn } from 'child_process';
import path from 'path';

interface Source {
  name: string;
  script: string;
  /** Rough expectation, only used to start the slowest first so the pool drains evenly. */
  weight: number;
}

// Ordered heaviest-first: with a pool, starting the long tail early is what shortens wall clock.
const SOURCES: Source[] = [
  // jobspy first: it is the only source with a real recency filter and it reports posting dates.
  { name: 'jobspy', script: 'ingest-jobspy.ts', weight: 10 },
  { name: 'linkedin', script: 'ingest-linkedin.ts', weight: 9 },
  // Naukri needs a visible per-job page check to distinguish direct Apply from company-site Apply.
  { name: 'naukri', script: 'ingest-naukri.ts', weight: 9 },
  { name: 'hirist', script: 'ingest-hirist.ts', weight: 8 },
  { name: 'himalayas', script: 'ingest-himalayas.ts', weight: 7 },
  { name: '4dayweek', script: 'ingest-4dayweek.ts', weight: 6 },
  { name: 'ashby', script: 'ingest-ashby.ts', weight: 5 },
  { name: 'greenhouse', script: 'ingest-greenhouse.ts', weight: 4 },
  { name: 'hn', script: 'ingest-hn.ts', weight: 3 },
  { name: 'wwr', script: 'ingest-wwr.ts', weight: 2 },
  { name: 'remotive', script: 'ingest-remotive.ts', weight: 2 },
  { name: 'lever', script: 'ingest-lever.ts', weight: 1 },
  { name: 'remoteok', script: 'ingest-remoteok.ts', weight: 1 },
];

const CONCURRENCY = Math.max(1, Math.min(8, parseInt(process.env.INGEST_CONCURRENCY || '4', 10) || 4));
const ONLY = (process.env.INGEST_ONLY || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function runSource(src: Source): Promise<{ name: string; ok: boolean; ms: number; tail: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js'), path.join('scripts', src.script)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(src.name === 'naukri'
            ? { NAUKRI_CLASSIFY_APPLY: '1', NAUKRI_DIRECT_ONLY: '1' }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const lines: string[] = [];
    const collect = (buf: Buffer) => {
      for (const l of buf.toString().split(/\r?\n/)) {
        if (l.trim()) lines.push(l);
      }
      // Keep memory bounded on chatty sources (himalayas can log thousands of lines).
      if (lines.length > 400) lines.splice(0, lines.length - 400);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (e) => {
      resolve({ name: src.name, ok: false, ms: Date.now() - started, tail: `spawn failed: ${e.message}` });
    });
    child.on('close', (code) => {
      resolve({
        name: src.name,
        ok: code === 0,
        ms: Date.now() - started,
        tail: lines.slice(-3).join(' | ') || '(no output)',
      });
    });
  });
}

async function main() {
  const queue = SOURCES.filter((s) => ONLY.length === 0 || ONLY.includes(s.name)).sort((a, b) => b.weight - a.weight);
  if (queue.length === 0) {
    console.log(`ingest-all: nothing to run (INGEST_ONLY=${process.env.INGEST_ONLY})`);
    return;
  }

  console.log(`ingest-all: ${queue.length} sources, concurrency ${CONCURRENCY}`);
  console.log(`  ${queue.map((s) => s.name).join(', ')}\n`);
  const started = Date.now();
  const results: Array<{ name: string; ok: boolean; ms: number; tail: string }> = [];
  let inFlight = 0;

  const worker = async () => {
    for (;;) {
      const src = queue.shift();
      if (!src) return;
      inFlight++;
      console.log(`  ▶ ${src.name} started (${inFlight} running)`);
      const r = await runSource(src);
      inFlight--;
      results.push(r);
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name} finished in ${(r.ms / 1000).toFixed(0)}s — ${r.tail.slice(0, 140)}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  const total = (Date.now() - started) / 1000;
  const failed = results.filter((r) => !r.ok);
  const slowest = [...results].sort((a, b) => b.ms - a.ms)[0];
  console.log(`\ningest-all done in ${total.toFixed(0)}s — ${results.length - failed.length} ok, ${failed.length} failed`);
  if (slowest) {
    console.log(`  slowest source: ${slowest.name} at ${(slowest.ms / 1000).toFixed(0)}s (that is the floor for the whole step)`);
  }
  if (failed.length) {
    console.log(`  failed: ${failed.map((f) => f.name).join(', ')}`);
    // Deliberately exit 0 unless EVERYTHING failed: one blocked scraper must not fail the sync,
    // which is what the old `&&` chain did.
    if (failed.length === results.length) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('ingest-all error:', e);
  process.exitCode = 1;
});
