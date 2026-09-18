import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Point the shared DB module at a throwaway file BEFORE anything imports it.
 *
 * `src/lib/db.ts` resolves its path at module-evaluation time, so this must run first — hence the
 * `import './setup-db'` at the top of every DB-touching suite rather than a `beforeAll`.
 *
 * This override only works because `db.ts` honours `HIRESIGNAL_DB`. It did NOT until recently: the
 * variable was read only by `scripts/prune-stale.ts`, so a "dry run against a copy" of any script
 * importing this module silently wrote to the real database instead. Tests would have done the
 * same.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiresignal-test-'));
export const TEST_DB_PATH = path.join(dir, 'test.db');
process.env.HIRESIGNAL_DB = TEST_DB_PATH;

/** Insert a minimal job row and return its id. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function seedJob(
  db: any,
  overrides: Partial<{ title: string; company: string; url: string; description: string; dedup: string }> = {},
): number {
  const title = overrides.title ?? 'Integration Architect';
  const company = overrides.company ?? 'Acme Health';
  const url = overrides.url ?? 'https://example.com/jobs/1';
  const dedup = overrides.dedup ?? `dedup-${Math.random().toString(36).slice(2)}`;
  const res = db
    .prepare(
      `INSERT INTO job_postings (source, company, title, location, description, url, dedup_hash)
       VALUES ('test', ?, ?, 'Remote', ?, ?, ?)`,
    )
    .run(company, title, overrides.description ?? 'Build FHIR pipelines.', url, dedup);
  return Number(res.lastInsertRowid);
}
