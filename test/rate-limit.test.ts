import './setup-db';
import { describe, it, expect, beforeEach } from 'vitest';
import db from '@/lib/db';
import { checkRateLimit } from '@/lib/apply/prepare';
import { getApplyConfig, saveApplyConfig } from '@/lib/apply/questions';
import { seedJob } from './setup-db';

/**
 * REGRESSION: the auto-apply rate limits must actually count.
 *
 * The window used to be bounded with `new Date(...).toISOString()` — "2026-08-29T17:22:33.000Z",
 * a 'T' separator — while `apply_audit.attempted_at` is `DATETIME DEFAULT CURRENT_TIMESTAMP`, i.e.
 * "2026-08-29 18:22:33" with a SPACE. A TEXT comparison reaches character 11 and compares ' ' (32)
 * against 'T' (84), so every row written on the same DATE sorted below the threshold.
 *
 * Consequence: the HOURLY cap counted 0 forever and could never fire — measured, with 3 successes
 * inserted seconds before the check. The daily cap only appeared to work because its window starts
 * on the previous date, so the values differ at character 9, before the separator matters.
 */
describe('auto-apply rate limits', () => {
  let jobId: number;

  beforeEach(() => {
    db.prepare('DELETE FROM apply_audit').run();
    jobId = seedJob(db);
  });

  const record = (n: number, status = 'success') => {
    for (let i = 0; i < n; i++) {
      db.prepare('INSERT INTO apply_audit (job_id, strategy, status) VALUES (?, ?, ?)').run(jobId, 'greenhouse', status);
    }
  };

  it('counts submissions made moments ago (the format bug)', () => {
    saveApplyConfig({ ...getApplyConfig(), rateLimit: { perDay: 100, perHour: 100 } });
    record(3);
    const r = checkRateLimit('greenhouse');
    // Before the fix this was 0 — rows written in the same second were invisible to the window.
    expect(r.counts.thisHour).toBe(3);
    expect(r.counts.today).toBe(3);
  });

  it('blocks at the hourly cap', () => {
    saveApplyConfig({ ...getApplyConfig(), rateLimit: { perDay: 1000, perHour: 2 } });
    record(2);
    const r = checkRateLimit('greenhouse');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hourly/i);
  });

  it('blocks at the daily cap', () => {
    saveApplyConfig({ ...getApplyConfig(), rateLimit: { perDay: 3, perHour: 1000 } });
    record(3);
    const r = checkRateLimit('greenhouse');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/daily/i);
  });

  it('allows while under both caps', () => {
    saveApplyConfig({ ...getApplyConfig(), rateLimit: { perDay: 10, perHour: 5 } });
    record(2);
    expect(checkRateLimit('greenhouse').ok).toBe(true);
  });

  it('only SUCCESSFUL attempts consume the cap', () => {
    saveApplyConfig({ ...getApplyConfig(), rateLimit: { perDay: 2, perHour: 2 } });
    record(5, 'dry_run');
    record(5, 'error');
    record(5, 'submitted_unconfirmed');
    const r = checkRateLimit('greenhouse');
    expect(r.counts.today).toBe(0);
    expect(r.ok).toBe(true);
  });
});
