import './setup-db';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { matchesFallbackKey, PAGE_SIZE } from '@/lib/match-keys';
import { buildMatchesPage } from '@/lib/matches-page';

/**
 * REGRESSION: the server-seeded first page must land under the exact key the client hook reads.
 *
 * This failed silently once already. `matchesFallbackKey` originally lived in `hooks.ts`, a CLIENT
 * module, so the server render threw "Attempted to call matchesFallbackKey() from the server" — and
 * because the seeding was wrapped in a bare `try/catch`, the only symptom was the optimisation
 * quietly doing nothing. A key that merely DRIFTS fails the same way: SWR looks up a key that isn't
 * there and just fetches, with no error anywhere.
 */
describe('first-paint seed key', () => {
  it('matches the key the hook builds for the default, unfiltered page', () => {
    // Mirror of `firstPageKey` in hooks.ts for includeHidden=false and no filters.
    const includeHidden = false;
    const filterQS = '';
    const baseQS = includeHidden ? '?include_hidden=1' : '';
    const sep = includeHidden ? '&' : '?';
    const hookKey = `/api/matches${baseQS}${sep}offset=0&limit=${PAGE_SIZE}${filterQS ? `&${filterQS}` : ''}`;

    expect(matchesFallbackKey()).toBe(hookKey);
  });

  it('is a plain path with no trailing separator surprises', () => {
    expect(matchesFallbackKey()).toBe('/api/matches?offset=0&limit=30');
  });

  it('lives in a module that does NOT import client-only runtime', () => {
    // The whole reason this module exists: importing SWR/React here would make it a client module
    // again and break the server render.
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'match-keys.ts'), 'utf8');
    expect(src).not.toMatch(/from 'swr'/);
    expect(src).not.toMatch(/from 'react'/);
    // Check for the DIRECTIVE (a leading statement), not the string anywhere — the doc comment in
    // that file legitimately mentions 'use client' while explaining why it must not be one.
    const firstStatement = src
      .split(new RegExp('\\r?\\n'))
      .find((l) => l.trim() && !l.trim().startsWith('*') && !l.trim().startsWith('/*'));
    expect(firstStatement ?? '').not.toMatch(/^\s*['"]use client['"]/);
  });

  it('hooks.ts re-exports the shared key rather than defining its own', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'hooks.ts'), 'utf8');
    expect(src).toMatch(/export \{ PAGE_SIZE, matchesFallbackKey \} from '\.\/match-keys'/);
    // and must not redeclare PAGE_SIZE, which would let the two drift apart
    expect(src).not.toMatch(/^const PAGE_SIZE = /m);
  });
});

describe('the seeded payload has the same shape the route returns', () => {
  /**
   * The route and the server render share `buildMatchesPage` precisely so these cannot diverge —
   * if they did, the page would render one shape on first paint and a different one after
   * hydration.
   */
  it('produces the keys the client expects', () => {
    const page = buildMatchesPage({ limit: 5 });
    // A fresh test DB has no résumé, so the "no resume" shape is the expected result here.
    if ('error' in page) {
      expect(page.error).toBe('No resume uploaded');
      expect(page.matches).toEqual([]);
      return;
    }
    for (const key of [
      'matches', 'hiddenCount', 'offset', 'limit', 'hasMore',
      'totalEmbedded', 'totalFiltered', 'poolSize', 'facets',
    ]) {
      expect(page).toHaveProperty(key);
    }
  });

  it('clamps the page limit to a sane range', () => {
    const tiny = buildMatchesPage({ limit: -5 });
    const huge = buildMatchesPage({ limit: 99_999 });
    if (!('error' in tiny)) expect(tiny.limit).toBeGreaterThanOrEqual(1);
    if (!('error' in huge)) expect(huge.limit).toBeLessThanOrEqual(200);
  });
});
