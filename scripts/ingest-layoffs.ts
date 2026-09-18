// Bulk-refresh Layoffs.fyi data into the local SQLite cache.
// Approach: load the public Airtable embed in Playwright with a route handler that
// rewrites `allowMsgpackOfResult:true` → `false`, intercept the resulting JSON
// readSharedViewData response, then upsert one row per event.
//
// Run: `npm run ingest:layoffs`. ~5-10 sec total. The Airtable response is ~3 MB
// and contains every layoff event since 2020 (~4400 rows as of 2026-05). Rows are
// deduped by (company_slug, layoff_date, laid_off_count) so re-running is idempotent.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { chromium, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';

interface AirtableColumn {
  id: string;
  name: string;
  type: string;
  typeOptions?: { choices?: Record<string, { id: string; name: string }> };
}
interface AirtableRow {
  id: string;
  cellValuesByColumnId: Record<string, unknown>;
}

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hiresignal.db'));
sqliteVec.load(db);
db.pragma('journal_mode = WAL');
// Per-connection: the NORMAL set in src/lib/db.ts does not reach a standalone script, and
// better-sqlite3 defaults to FULL — one fsync per autocommit write.
db.pragma('synchronous = NORMAL');
// REQUIRED once ingest sources run concurrently: WAL allows one writer at a time, and without
// a busy timeout a second writer fails immediately with SQLITE_BUSY instead of waiting its turn.
db.pragma('busy_timeout = 15000');
db.exec(`
  CREATE TABLE IF NOT EXISTS layoffs_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    company_slug TEXT NOT NULL,
    laid_off_count INTEGER,
    laid_off_pct REAL,
    layoff_date TEXT,
    industry TEXT,
    country TEXT,
    location_hq TEXT,
    stage TEXT,
    funds_raised_mm REAL,
    source_url TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_slug, layoff_date, laid_off_count)
  );
  CREATE INDEX IF NOT EXISTS layoffs_company_idx ON layoffs_data(company_slug);
`);

function slugify(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

async function fetchAirtableData(): Promise<{ columns: AirtableColumn[]; rows: AirtableRow[] }> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1400, height: 1200 },
  });
  // Force JSON instead of msgpack so we can parse without an extra dep
  await ctx.route('**/v0.3/view/*/readSharedViewData**', async (route) => {
    const rewritten = route
      .request()
      .url()
      .replace('%22allowMsgpackOfResult%22%3Atrue', '%22allowMsgpackOfResult%22%3Afalse');
    await route.continue({ url: rewritten });
  });
  const page: Page = await ctx.newPage();

  let captured: { columns: AirtableColumn[]; rows: AirtableRow[] } | null = null;
  page.on('response', async (resp) => {
    if (!resp.url().includes('readSharedViewData')) return;
    try {
      const json = await resp.json();
      const t = json?.data?.table;
      if (t?.rows && t.columns) captured = { columns: t.columns, rows: t.rows };
    } catch { /* not JSON or already consumed */ }
  });

  console.log('Loading Layoffs.fyi Airtable embed…');
  await page.goto(
    'https://airtable.com/embed/app1PaujS9zxVGUZ4/shroKsHx3SdYYOzeh?backgroundColor=green&viewControls=on',
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  );
  // Wait for the readSharedViewData XHR to land + get parsed
  for (let i = 0; i < 30 && !captured; i++) await page.waitForTimeout(1000);
  await browser.close();
  if (!captured) throw new Error('Failed to capture Airtable readSharedViewData response');
  return captured;
}

async function main() {
  console.log('Ingesting Layoffs.fyi…');
  const { columns, rows } = await fetchAirtableData();
  console.log(`  fetched ${rows.length} rows · ${columns.length} columns`);

  // Build lookups: column id → name; select id → label per column
  const colByName = new Map<string, AirtableColumn>();
  const selectLabels = new Map<string, Map<string, string>>(); // colId → (selId → label)
  for (const c of columns) {
    colByName.set(c.name, c);
    if (c.type === 'select' || c.type === 'multiSelect') {
      const m = new Map<string, string>();
      for (const [id, opt] of Object.entries(c.typeOptions?.choices || {})) {
        m.set(id, opt.name);
      }
      selectLabels.set(c.id, m);
    }
  }
  const colId = (name: string): string | null => colByName.get(name)?.id || null;
  const resolveSelect = (colId: string | null, val: unknown): string | null => {
    if (!colId || !val) return null;
    const labels = selectLabels.get(colId);
    if (!labels) return null;
    if (typeof val === 'string') return labels.get(val) || null;
    if (Array.isArray(val)) {
      return val.map((v) => labels.get(v as string) || '').filter(Boolean).join(', ') || null;
    }
    return null;
  };

  const ids = {
    company: colId('Company'),
    locHq: colId('Location HQ'),
    laidOff: colId('# Laid Off'),
    date: colId('Date'),
    pct: colId('%'),
    industry: colId('Industry'),
    source: colId('Source'),
    stage: colId('Stage'),
    fundsRaised: colId('$ Raised (mm)'),
    country: colId('Country'),
  };

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO layoffs_data
      (company, company_slug, laid_off_count, laid_off_pct, layoff_date,
       industry, country, location_hq, stage, funds_raised_mm, source_url, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const tx = db.transaction((events: AirtableRow[]) => {
    let added = 0;
    let skipped = 0;
    for (const r of events) {
      const cv = r.cellValuesByColumnId;
      const company = (ids.company ? (cv[ids.company] as string) : '') || '';
      if (!company.trim()) { skipped++; continue; }
      const slug = slugify(company);
      const dateRaw = ids.date ? (cv[ids.date] as string | undefined) : undefined;
      const layoffDate = dateRaw ? dateRaw.slice(0, 10) : null;
      const result = insertStmt.run(
        company,
        slug,
        ids.laidOff && cv[ids.laidOff] != null ? Number(cv[ids.laidOff]) : null,
        ids.pct && cv[ids.pct] != null ? Number(cv[ids.pct]) : null,
        layoffDate,
        resolveSelect(ids.industry, cv[ids.industry || '']),
        resolveSelect(ids.country, cv[ids.country || '']),
        resolveSelect(ids.locHq, cv[ids.locHq || '']),
        resolveSelect(ids.stage, cv[ids.stage || '']),
        ids.fundsRaised && cv[ids.fundsRaised] != null ? Number(cv[ids.fundsRaised]) : null,
        ids.source ? (cv[ids.source] as string) || null : null,
      );
      if (result.changes > 0) added++;
    }
    return { added, skipped };
  });
  const { added, skipped } = tx(rows);

  const totalNow = (db.prepare('SELECT COUNT(*) as n FROM layoffs_data').get() as { n: number }).n;
  console.log(`  added ${added} new events (${skipped} rows skipped, ${totalNow} total in DB)`);
  db.close();
}

main().catch((err) => {
  console.error('Layoffs ingest error:', err.message);
  db.close();
  process.exit(1);
});
