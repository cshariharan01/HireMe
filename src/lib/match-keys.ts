/**
 * SWR cache keys for the match list — shared by the CLIENT hook and the SERVER component.
 *
 * This lives in its own module on purpose. It started in `src/lib/hooks.ts`, which is a client
 * module (it imports SWR and React hooks and is pulled in by `'use client'` components), so calling
 * it during the server render failed with:
 *
 *   "Attempted to call matchesFallbackKey() from the server but matchesFallbackKey is on the
 *    client. It's not possible to invoke a client function from the server."
 *
 * That error was being swallowed by a `try/catch` around the seeding, so the only symptom was the
 * first-paint optimisation silently doing nothing. Keeping the key in a dependency-free module
 * means both sides compute it from the same source and neither imports the other's runtime.
 */

/** Rows per page in the match list. The seeded first page must use exactly this. */
export const PAGE_SIZE = 30;

/**
 * The key for the DEFAULT, unfiltered first page.
 *
 * A seed stored under any other key is silently ignored — SWR simply never looks it up — so this
 * must stay character-for-character identical to the key `useMatches` builds for the no-filter
 * case.
 */
export function matchesFallbackKey(): string {
  return `/api/matches?offset=0&limit=${PAGE_SIZE}`;
}
