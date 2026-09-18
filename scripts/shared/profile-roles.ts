// Shared helper for ingestion scripts: read the user's curated target roles from the DB.
//
// Safe to import from scripts — it takes an already-open better-sqlite3 handle and only
// runs a SELECT, so it has NONE of the auto-schema side effects that importing
// `src/lib/db.ts` would trigger (see CLAUDE.md on the deliberate script/lib split).
//
// Used by the keyword scrapers (linkedin / hirist / naukri) and company discovery to
// drive their search queries from the resume-derived, user-selected roles instead of a
// hardcoded list. Falls back to the caller's defaults when no roles are set.

import type Database from 'better-sqlite3';

/**
 * Return the user's enabled target roles (my_profile.parsed_json.targets.roles).
 * Returns [] when there is no profile, no roles, or the JSON can't be read — callers
 * should fall back to their own hardcoded defaults in that case.
 */
export function getEnabledRoles(db: Database.Database): string[] {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as
      | { parsed_json: string }
      | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.parsed_json);
    const roles = parsed?.targets?.roles;
    if (!Array.isArray(roles)) return [];
    return roles
      .filter((r: unknown): r is string => typeof r === 'string')
      .map((r) => r.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve search queries: enabled roles if any, else the provided fallback list. */
export function resolveRoleQueries(db: Database.Database, fallback: string[]): string[] {
  const roles = getEnabledRoles(db);
  return roles.length ? roles : fallback;
}

/**
 * Return the user's years of experience from my_profile.parsed_json.
 * Returns the provided fallback (default 3) when not set.
 */
export function getProfileYoe(db: Database.Database, fallback = 3): number {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as
      | { parsed_json: string }
      | undefined;
    if (!row) return fallback;
    const parsed = JSON.parse(row.parsed_json);
    const yoe =
      parsed?.yearsOfExperience ??
      parsed?.yearsExperience ??
      parsed?.targets?.yearsOfExperience ??
      null;
    if (typeof yoe === 'number' && yoe > 0) return Math.round(yoe);
    if (typeof yoe === 'string') {
      const n = parseFloat(yoe);
      if (!isNaN(n) && n > 0) return Math.round(n);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build the final deduplicated search role list.
 * Uses profile roles when available, falls back to defaults.
 * Does NOT append hardcoded DE tech variants — those only made sense for one user.
 */
export function resolveSearchRoles(db: Database.Database, defaults: string[]): string[] {
  const roles = getEnabledRoles(db);
  const base = roles.length ? roles : defaults;
  return Array.from(new Set(base));
}
