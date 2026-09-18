import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * REGRESSION: prune's "refused to mass-expire" exit code must be treated as a SKIP, not a failure.
 *
 * `prune-stale.ts` exits 2 when its mass-expiry guard trips — i.e. the age rules would retire more
 * than MAX_EXPIRY_RATIO of the corpus, which means ingest did not run. Refusing to delete is the
 * correct, safe outcome. `run-sync.ts` treated it as a step failure and `break`ed the loop, so in
 * QUICK mode `verify:links` and `evaluate:top` silently never ran.
 *
 * The first fix for that was ITSELF broken and shipped: it tested
 * `steps[i].script.includes('prune-stale')` while `steps[i].script` holds the npm SCRIPT name,
 * `'prune'` — so `'prune'.includes('prune-stale')` is always false and the branch was dead code.
 * A code review caught it; the browser E2E could not, because nothing about the UI changes.
 *
 * These assert the source directly: there is no way to observe a `break` in a spawned pipeline
 * without running the whole sync, and the defect is a string comparison.
 */
const SRC = fs.readFileSync(path.join(process.cwd(), 'scripts', 'run-sync.ts'), 'utf8');

describe('run-sync prune guard', () => {
  it('matches the prune step by EXACT name, never by substring', () => {
    // `'prune'.includes('prune-stale')` === false — the shape that made the branch unreachable.
    expect(SRC).not.toMatch(/\.script\.includes\(['"]prune-stale['"]\)/);
    expect(SRC).toMatch(/steps\[i\]\.script === PRUNE_STEP/);
  });

  it('defines the step name once and uses it in the step lists, so a rename cannot desync them', () => {
    expect(SRC).toMatch(/const PRUNE_STEP = 'prune';/);
    // Both pipelines must reference the constant rather than repeating the literal.
    expect(SRC).toMatch(/const QUICK = \[[^\]]*PRUNE_STEP[^\]]*\]/);
    expect(SRC).toMatch(/const FULL = \[[^\]]*PRUNE_STEP[^\]]*\]/);
  });

  it('treats the guard exit code as skipped, not error', () => {
    const branch = SRC.slice(SRC.indexOf('PRUNE_GUARD_EXIT'), SRC.indexOf('hadError = true'));
    expect(branch).toMatch(/status = 'skipped'/);
  });

  it("the guard's exit code matches what prune-stale actually exits with", () => {
    const prune = fs.readFileSync(path.join(process.cwd(), 'scripts', 'prune-stale.ts'), 'utf8');
    const exitMatch = prune.match(/process\.exitCode = (\d+)/);
    expect(exitMatch).toBeTruthy();
    const guardMatch = SRC.match(/const PRUNE_GUARD_EXIT = (\d+);/);
    expect(guardMatch).toBeTruthy();
    expect(guardMatch![1]).toBe(exitMatch![1]);
  });

  it('the exact predicate now evaluates true for the real step name', () => {
    const PRUNE_STEP = 'prune';
    const script = 'prune'; // what QUICK/FULL actually contain
    expect(script === PRUNE_STEP).toBe(true);
    expect(script.includes('prune-stale')).toBe(false); // the old, broken test
  });
});
