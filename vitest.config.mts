import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Test config.
 *
 * WHY THIS EXISTS: there was no test framework at all. A code review found two defects on the
 * primary user path — previewing a job silently marked it applied, and a prune-guard branch that
 * could never fire (`'prune'.includes('prune-stale')`) — and the 17-check browser E2E driver caught
 * neither, because both are logic errors that a passing UI hides. Each is one assertion.
 *
 * `pool: 'forks'` is required: better-sqlite3 and sqlite-vec are native addons, and the default
 * worker-thread pool cannot load them.
 */
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    // The suites that touch SQLite share one on-disk fixture DB, so they must not run concurrently.
    fileParallelism: false,
    testTimeout: 20_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
