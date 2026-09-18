import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guards the ATS adapter set: every platform in the `Ats` union must have BOTH a detection route and
 * a puller wired into `pullBoard`.
 *
 * The failure this prevents is specific and was hit for real: `workday` was in the union and
 * detectable, while `pullBoard` had `case 'workday': return []`. Detection therefore "succeeded",
 * the board pulled nothing, AND the crawl fallback was suppressed because an ATS had been found. A
 * half-wired adapter is worse than no adapter.
 *
 * Live behaviour is verified separately by `.notes/scripts/verify-all-adapters.ts`, which drives
 * detectAts -> pullBoard against a known-live tenant per platform and asserts a non-zero job count
 * (currently 14/14).
 */
const DIR = path.join(process.cwd(), 'src', 'lib', 'discovery');
const DETECT = fs.readFileSync(path.join(DIR, 'ats-detect.ts'), 'utf8');
const PULL = fs.readFileSync(path.join(DIR, 'ats-pull.ts'), 'utf8');

/** The declared union, parsed from source so the test cannot drift from it. */
const union = (() => {
  const start = DETECT.indexOf('export type Ats =');
  const body = DETECT.slice(start, DETECT.indexOf(';', start));
  return Array.from(body.matchAll(/'([a-z]+)'/g)).map((m) => m[1]);
})();

describe('ATS adapter coverage', () => {
  it('declares the platforms we support', () => {
    expect(union.length).toBeGreaterThanOrEqual(14);
    for (const expected of [
      'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workday',
      'workable', 'breezy', 'pinpoint', 'bamboohr', 'personio', 'teamtailor', 'rippling', 'manatal',
    ]) {
      expect(union, expected).toContain(expected);
    }
  });

  it('every platform in the union has a puller wired into pullBoard', () => {
    const sw = PULL.slice(PULL.indexOf('switch (match.ats)'), PULL.indexOf('} catch', PULL.indexOf('switch (match.ats)')));
    for (const ats of union) {
      expect(sw, `${ats} missing from pullBoard`).toContain(`case '${ats}':`);
      // and it must actually call something, not stub out
      expect(sw, `${ats} is stubbed to return []`).not.toMatch(
        new RegExp(`case '${ats}': return \\[\\]`),
      );
    }
  });

  it('every platform can be reached by detection', () => {
    for (const ats of union) {
      const inToMatch = DETECT.includes(`case '${ats}':`);
      const inUrlPatterns = new RegExp(`ats: '${ats}', re:`).test(DETECT);
      const inProbes = new RegExp(`ats: '${ats}',\\s*\\n?\\s*url:`).test(DETECT) ||
        new RegExp(`\\{ ats: '${ats}', url:`).test(DETECT);
      expect(inToMatch, `${ats} has no boardApi mapping`).toBe(true);
      // Workday is URL-only by design (tenant cannot be guessed from a name) so it has no probe.
      if (ats !== 'workday') {
        expect(inUrlPatterns || inProbes, `${ats} is not reachable by URL sniff or name probe`).toBe(true);
      }
    }
  });
});

describe('probes never accept an empty board', () => {
  /**
   * Three false positives this session all came from a presence-only check on a 200 response:
   * SmartRecruiters returns `totalFound: 0` for any slug, an Ashby board named `jobs` exists and is
   * empty, and `jobs.recruitee.com` is a real board belonging to someone else.
   */
  it('the new probes assert a non-empty result', () => {
    const probeBlock = DETECT.slice(DETECT.indexOf('const probes'), DETECT.indexOf('Promise.all'));
    for (const ats of ['workable', 'pinpoint', 'bamboohr', 'manatal']) {
      const line = probeBlock.slice(probeBlock.indexOf(`ats: '${ats}'`));
      expect(line.slice(0, 400), ats).toMatch(/nonEmptyArray|nonEmptyTopLevelArray/);
    }
  });

  it('XML feeds assert a repeated element, not just a 200', () => {
    const probeBlock = DETECT.slice(DETECT.indexOf('const probes'), DETECT.indexOf('Promise.all'));
    expect(probeBlock).toMatch(/<position/);
    expect(probeBlock).toMatch(/<item/);
  });

  it('generic infrastructure hostnames are never probed as a company slug', () => {
    // `api.rippling.com` derived the slug `api`, which matched an unrelated Manatal board and
    // would have imported ITS jobs under the wrong company.
    const block = DETECT.slice(DETECT.indexOf('GENERIC_HOST_PREFIXES = new Set('));
    for (const p of ['api', 'ats', 'board', 'platform', 'jobs', 'careers']) {
      expect(block.slice(0, 700), p).toContain(`'${p}'`);
    }
  });
});
