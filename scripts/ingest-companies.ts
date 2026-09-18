// ingest-companies.ts — discover jobs directly from company career pages.
//
// Reads scripts/data/companies.txt (one company name or careers/home URL per line; # comments).
// For each: detect the ATS and pull its whole board via public API; if no ATS is found, fall
// back to a generic Playwright crawl. All discovered jobs are stored under source='company'
// with the same freshness upsert + seniority/domain gate as the other sources.
//
// Not limited to healthcare: healthcare-IT is prioritized (domain_priority), but any senior
// technical/architect role is kept (isSeniorRelevant), matching the user's "explore all
// matching jobs" goal.
//
// Run: npx ts-node scripts/ingest-companies.ts   (part of `npm run daily`)

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
import { detectAts } from '../src/lib/discovery/ats-detect';
import { pullBoard, type NormalizedJob } from '../src/lib/discovery/ats-pull';
import { crawlCareersPage } from '../src/lib/discovery/crawl';
import { classifyJob } from '../src/lib/job-classifier';
import { isDomainPriority } from '../src/lib/ontology';
import { isSeniorRelevant } from '../src/lib/seniority';
import { resolveAllowJunior } from './shared/profile-level';
import { ensureFreshnessColumns, markSourceAbsent } from './shared/freshness';

const SOURCE = 'company';
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hiresignal.db'));
const allowJunior = resolveAllowJunior(db); // experience-aware: keep junior roles for early-career resumes
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
// Per-connection: the NORMAL set in src/lib/db.ts does not reach a standalone script, and
// better-sqlite3 defaults to FULL — one fsync per autocommit write.
db.pragma('synchronous = NORMAL');
// REQUIRED once ingest sources run concurrently: WAL allows one writer at a time, and without
// a busy timeout a second writer fails immediately with SQLITE_BUSY instead of waiting its turn.
db.pragma('busy_timeout = 15000');

db.exec(`
  CREATE TABLE IF NOT EXISTS job_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT, company TEXT, title TEXT, location TEXT,
    description TEXT, url TEXT, embedding BLOB,
    domain_priority INTEGER DEFAULT 0,
    remote_policy TEXT, visa_sponsorship INTEGER DEFAULT 0, relocation_offered INTEGER DEFAULT 0,
    dedup_hash TEXT UNIQUE,
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
for (const spec of ['remote_policy TEXT', 'visa_sponsorship INTEGER DEFAULT 0', 'relocation_offered INTEGER DEFAULT 0']) {
  try { db.exec(`ALTER TABLE job_postings ADD COLUMN ${spec}`); }
  catch (e) { if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e; }
}
ensureFreshnessColumns(db);

// Detection cache. `detectAts` is the expensive half of a seed: for a plain company name it probes
// up to 5 ATS APIs per candidate slug, and a miss then falls through to a full Playwright crawl.
// An ATS almost never changes, so re-detecting all 160 seeds on every run was pure waste.
// Board CONTENT is still pulled every run (that's the point) — only detection is cached.
db.exec(`
  CREATE TABLE IF NOT EXISTS discovery_probes (
    seed TEXT PRIMARY KEY,
    ats TEXT,
    slug TEXT,
    supported INTEGER DEFAULT 0,
    probed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
const PROBE_TTL_DAYS = parseInt(process.env.DISCOVERY_PROBE_TTL_DAYS || '14', 10) || 14;
const probeGet = db.prepare(
  "SELECT ats, slug, supported FROM discovery_probes WHERE seed = ? AND probed_at >= datetime('now', ?)",
);
const probePut = db.prepare(
  `INSERT INTO discovery_probes (seed, ats, slug, supported, probed_at)
   VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
   ON CONFLICT(seed) DO UPDATE SET ats = excluded.ats, slug = excluded.slug,
     supported = excluded.supported, probed_at = CURRENT_TIMESTAMP`,
);

const insertStmt = db.prepare(`
  INSERT INTO job_postings (source, company, title, location, description, url, domain_priority, remote_policy, visa_sponsorship, relocation_offered, dedup_hash, posted_at, last_seen_at, source_present)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(dedup_hash) DO UPDATE SET
    last_seen_at = CURRENT_TIMESTAMP,
    source_present = 1,
    posted_at = COALESCE(excluded.posted_at, posted_at)
`);

function readSeeds(): string[] {
  const file = path.join(process.cwd(), 'scripts', 'data', 'companies.txt');
  if (!fs.existsSync(file)) {
    console.log(`No seed file at ${file} — create it with one company name or careers URL per line.`);
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function insertJobs(jobs: NormalizedJob[]): number {
  let added = 0;
  for (const job of jobs) {
    const title = job.title || '';
    const description = (job.description || '').slice(0, 8000);
    if (!title || !job.url) continue;
    const domainPri = isDomainPriority(title + ' ' + description);
    // Keep healthcare-IT OR any senior technical/architect role; drop junior/non-eng noise.
    if (!domainPri && !isSeniorRelevant(title, { allowJunior })) continue;

    const cls = classifyJob(title, description, job.location || '');
    const hash = createHash('sha256').update(SOURCE + job.company + title + (job.location || '')).digest('hex');
    const result = insertStmt.run(
      SOURCE, job.company, title, job.location || '', description, job.url,
      domainPri ? 1 : 0, cls.remote_policy, cls.visa_sponsorship ? 1 : 0, cls.relocation_offered ? 1 : 0,
      hash, job.posted_at,
    );
    if (result.changes > 0) added++;
  }
  return added;
}

async function processSeed(seed: string, getBrowser?: () => Promise<unknown>): Promise<void> {
  try {
    // Cached detection first — see discovery_probes above.
    const cached = probeGet.get(seed, `-${PROBE_TTL_DAYS} days`) as
      | { ats: string; slug: string; supported: number }
      | undefined;
    let match = cached
      ? (cached.ats ? { ats: cached.ats as never, slug: cached.slug, supported: !!cached.supported } : null)
      : await detectAts(seed);
    if (!cached) {
      probePut.run(seed, match?.ats ?? null, match?.slug ?? null, match?.supported ? 1 : 0);
    }
    if (match && match.supported) {
      const jobs = await pullBoard(match, isUrl(seed) ? undefined : seed);
      const added = insertJobs(jobs);
      console.log(`  ✓ ${seed} → ${match.ats}/${match.slug}: ${jobs.length} pulled, ${added} added/updated`);
      return;
    }
    // No supported ATS (or Workday) → generic crawl if we have a URL to crawl.
    const crawlUrl = isUrl(seed) ? seed : match ? `https://${match.slug}.com/careers` : null;
    if (!crawlUrl) {
      console.log(`  ✗ ${seed}: no ATS detected and no URL to crawl — skipping`);
      return;
    }
    // Resolve the shared browser ONLY here — a seed that matched an ATS API never needs one, so a
    // run that hits only ATS boards launches no browser at all.
    const jobs = await crawlCareersPage(crawlUrl, { company: isUrl(seed) ? undefined : seed, browser: getBrowser ? await getBrowser() : undefined });
    const added = insertJobs(jobs);
    console.log(`  ~ ${seed} → crawl ${crawlUrl}: ${jobs.length} found, ${added} added/updated`);
  } catch (e) {
    console.log(`  ✗ ${seed}: ${(e as Error).message}`);
  }
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

async function main() {
  const seeds = readSeeds();
  console.log(`Discovering jobs from ${seeds.length} companies...`);
  if (!seeds.length) { db.close(); return; }
  markSourceAbsent(db, SOURCE);

  // ONE shared Chromium for every seed that needs a crawl, launched lazily so a run that hits
  // only ATS APIs never starts a browser at all.
  let browser: { close: () => Promise<void> } | undefined;
  const getBrowser = async () => {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      console.log('  (launched one shared Chromium for careers-page crawls)');
    }
    return browser;
  };

  // Seeds run CONCURRENTLY, a few at a time. They were strictly sequential with a blanket 3s gap
  // between companies — 480s of pure sleep before any work. Different seeds are different hosts,
  // so politeness is a per-host concern, not a global one; the pool bounds total load instead.
  const CONCURRENCY = Math.max(1, Math.min(8, parseInt(process.env.DISCOVER_CONCURRENCY || '4', 10) || 4));
  console.log(`  concurrency ${CONCURRENCY}, detection cached for ${PROBE_TTL_DAYS}d`);
  const queue = [...seeds];
  let done = 0;
  const worker = async () => {
    for (;;) {
      const seed = queue.shift();
      if (!seed) return;
      await processSeed(seed, getBrowser);
      done++;
      if (done % 20 === 0) console.log(`  progress: ${done}/${seeds.length} seeds`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (browser) await browser.close().catch(() => {});
  console.log('Company discovery complete.');
  db.close();
}

main();
