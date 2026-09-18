/**
 * Populate `ats_companies` — the searchable directory of company career boards.
 *
 * Source: the free, MIT-licensed dataset published by `kalil0321/ats-scrapers`
 * (https://storage.stapply.ai/jobhive/v1/companies.csv — ~80,000 companies, ~7MB, no API key).
 *
 * WHAT THIS IS AND ISN'T:
 * It is a DIRECTORY — which ATS a company uses and the URL of its board. It is never a job source.
 * Every posting HireSignal stores is still pulled fresh by our own adapters, so the jobs are ours
 * and current; only the company→ATS mapping comes from outside, and that changes slowly (a company
 * migrates ATS maybe once in years), which is why a weekly-refreshed directory is fine where a
 * weekly-refreshed job feed would not be.
 *
 * WHY IT MATTERS: seeding used to mean hand-hunting a careers URL, and for Workday that is close to
 * impossible — a pull needs tenant + data-centre host + site, and probing 15 plausible combinations
 * for Kaiser, HCA, Providence, Cigna and Elevance produced zero working boards. Here those three
 * parts arrive already resolved, for tens of thousands of employers.
 *
 * Only rows for ATS platforms we can actually PULL are stored (see `pullBoard`). Listing a company
 * we cannot fetch would just be a dead search result.
 *
 * Run: npm run sync:directory
 */
import './shared/env';
import db from '../src/lib/db';

const SOURCE_URL =
  process.env.ATS_DIRECTORY_URL || 'https://storage.stapply.ai/jobhive/v1/companies.csv';

/** Must match the `Ats` union in src/lib/discovery/ats-detect.ts. */
const SUPPORTED = new Set([
  'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workday',
  'workable', 'breezy', 'pinpoint', 'bamboohr', 'personio', 'teamtailor', 'rippling', 'manatal',
]);

/** The dataset's own ATS labels don't all match ours. */
const ALIASES: Record<string, string> = {
  breezyhr: 'breezy',
  pinpointhq: 'pinpoint',
  bamboo: 'bamboohr',
  'smart-recruiters': 'smartrecruiters',
  teamtailorats: 'teamtailor',
};

/**
 * Parse one CSV line, honouring quoted fields.
 *
 * Company names contain commas ("Acme, Inc.") and quotes, so a naive `split(',')` silently shifts
 * every later column — the URL would land in the slug field and the board would never resolve.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function main() {
  console.log(`Fetching company directory from ${SOURCE_URL} …`);
  const res = await fetch(SOURCE_URL, {
    headers: { Accept: 'text/csv' },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    console.error(`Directory fetch failed: HTTP ${res.status}. Nothing was changed.`);
    process.exitCode = 1;
    return;
  }
  const csv = await res.text();
  const lines = csv.split(/\r?\n/);
  console.log(`  downloaded ${(csv.length / 1048576).toFixed(1)}MB, ${lines.length - 1} rows`);

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const iAts = header.indexOf('ats');
  const iName = header.indexOf('name');
  const iSlug = header.indexOf('slug');
  const iUrl = header.indexOf('url');
  if (iAts < 0 || iName < 0 || iSlug < 0) {
    console.error(`Unexpected columns: ${header.join(', ')}. Nothing was changed.`);
    process.exitCode = 1;
    return;
  }

  const rows: Array<[string, string, string, string]> = [];
  let skippedUnsupported = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const rawAts = (f[iAts] || '').trim().toLowerCase();
    const ats = ALIASES[rawAts] || rawAts;
    if (!SUPPORTED.has(ats)) { skippedUnsupported++; continue; }
    const name = (f[iName] || '').trim();
    const slug = (f[iSlug] || '').trim();
    if (!name || !slug) continue;
    rows.push([ats, name, slug, (f[iUrl] || '').trim()]);
  }

  // Replace wholesale inside one transaction: the directory is a snapshot, and a half-applied
  // update would leave companies pointing at boards that moved.
  const insert = db.prepare(
    `INSERT INTO ats_companies (ats, name, slug, url) VALUES (?, ?, ?, ?)
     ON CONFLICT(ats, slug) DO UPDATE SET name = excluded.name, url = excluded.url`,
  );
  const apply = db.transaction((batch: typeof rows) => {
    db.prepare('DELETE FROM ats_companies').run();
    for (const r of batch) insert.run(...r);
  });
  apply(rows);

  const byAts = db
    .prepare('SELECT ats, COUNT(*) n FROM ats_companies GROUP BY ats ORDER BY n DESC')
    .all() as Array<{ ats: string; n: number }>;
  console.log(`\nStored ${rows.length} companies on ATS platforms we can pull:`);
  for (const r of byAts) console.log(`  ${String(r.n).padStart(6)}  ${r.ats}`);
  console.log(`  (skipped ${skippedUnsupported} on platforms we don't support yet)`);
  console.log('\nSearch them from /import → "Find a company".');
}

main()
  .catch((e) => {
    console.error('sync-company-directory failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.close());
