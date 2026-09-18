// recompute-matches.ts — rebuild the ranked-match cache in a SEPARATE PROCESS.
//
// WHY A PROCESS AND NOT A PROMISE: `computeRanked` is synchronous (better-sqlite3 is), so doing it
// "in the background" inside the server still blocks Node's event loop for its whole duration —
// measured 2.4s idle and ~7s while `npm run embed` is competing for the CPU. Any request that
// arrives during that window just waits, which is exactly the stall this was meant to remove.
//
// `src/lib/sync.ts` already established this pattern for the same reason (a detached child so the
// work survives `next dev` recompiles and never blocks a request). This is the same trick for the
// ranking recompute: the route serves the stale list instantly and spawns this, which writes the
// fresh payload into `match_cache` for the next request to pick up.
//
// Run: npx ts-node scripts/recompute-matches.ts [--hidden] [--expired] [--applied]

import './shared/env';
import { getRankedMatches } from '../src/lib/matches';

const args = new Set(process.argv.slice(2));
const opts = {
  includeHidden: args.has('--hidden'),
  includeExpired: args.has('--expired'),
  includeApplied: args.has('--applied'),
  refresh: true,
};

const started = Date.now();
try {
  const result = getRankedMatches(opts);
  console.log(
    `recompute-matches: ${result?.ranked.length ?? 0} ranked in ${Date.now() - started}ms ` +
      `(hidden=${opts.includeHidden} expired=${opts.includeExpired} applied=${opts.includeApplied})`,
  );
} catch (e) {
  console.error('recompute-matches failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
