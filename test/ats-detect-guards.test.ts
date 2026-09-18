import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * REGRESSION: ATS detection must not claim a board it cannot pull, or someone else's board.
 *
 * Three separate false positives were found by probing real companies, each with the same shape —
 * an API answering HTTP 200 for something that is not the company's board:
 *
 *  1. SmartRecruiters returns `{"totalFound":0,"content":[]}` for ANY slug, including
 *     `definitely-not-a-real-company-xyz987`. Every company not on Greenhouse/Lever/Ashby/Recruitee
 *     was reported as SmartRecruiters — Epic, Mayo, Kaiser included — pulling 0 jobs AND suppressing
 *     the crawl fallback, because "an ATS was detected".
 *  2. An Ashby board literally named `jobs` EXISTS and is empty (`{"jobs":[],"apiVersion":"1"}`).
 *     `jobs.cvshealth.com` derives the slug `jobs`, matched, and detection stopped there.
 *  3. `jobs.recruitee.com` is a REAL Recruitee board with 9 postings. Deriving `jobs` from a
 *     hostname would have imported those 9 unrelated jobs as CVS Health's.
 *
 * These are asserted against the source because reproducing them needs live network calls; the
 * live behaviour is verified separately in `.notes/scripts/probe-sniff.ts`.
 */
const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'discovery', 'ats-detect.ts'), 'utf8');

describe('probes require a NON-EMPTY board, not just HTTP 200', () => {
  it('SmartRecruiters checks totalFound / content length', () => {
    // The old test was `/"content"|"totalFound"/` — presence, not value.
    expect(SRC).not.toMatch(/\/"content"\|"totalFound"\/\.test\(b\)/);
    expect(SRC).toMatch(/totalFound \?\? 0\) > 0/);
  });

  it('Ashby checks the jobs array length', () => {
    expect(SRC).toMatch(/Array\.isArray\(j\.jobs\) && j\.jobs\.length > 0/);
  });

  it('Greenhouse / Lever / Recruitee still rely on a 404 for an unknown slug', () => {
    // Verified live: all three 404 on a made-up slug, so a presence check is safe for them.
    expect(SRC).toMatch(/boards-api\.greenhouse\.io/);
    expect(SRC).toMatch(/api\.lever\.co/);
  });
});

describe('generic hostname prefixes are never used as an ATS slug', () => {
  it('defines the blocklist and applies it before probing', () => {
    expect(SRC).toMatch(/GENERIC_HOST_PREFIXES/);
    expect(SRC).toMatch(/if \(GENERIC_HOST_PREFIXES\.has\(host\.toLowerCase\(\)\)\) return null;/);
  });

  it('covers the prefixes that are real tenants somewhere', () => {
    const block = SRC.slice(SRC.indexOf('GENERIC_HOST_PREFIXES = new Set('));
    for (const p of ['jobs', 'careers', 'apply', 'talent', 'hiring', 'work']) {
      expect(block, p).toContain(`'${p}'`);
    }
  });
});

describe('Ashby URL sniffing handles both board shapes', () => {
  it('captures the company from the PATH for jobs.ashbyhq.com/<company>', () => {
    // Matching only the subdomain captured the literal "jobs" for this form.
    expect(SRC).toMatch(/jobs\\\.ashbyhq\\\.com\\\/\(\[a-z0-9-\]\+\)/);
  });

  it('excludes the jobs. subdomain from the company-subdomain pattern', () => {
    expect(SRC).toMatch(/\(\?!jobs\\\.\)/);
  });
});

describe('Workday is only ever reported as supported when it came from a URL', () => {
  it('derives the board API from a parsed tenant/site rather than a company name', () => {
    expect(SRC).toMatch(/parseWorkdaySlug\(slug\)/);
    expect(SRC).toMatch(/wday\/cxs\/\$\{wd\.tenant\}\/\$\{wd\.site\}\/jobs/);
  });
});
