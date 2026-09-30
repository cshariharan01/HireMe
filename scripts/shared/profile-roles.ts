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
 * Falls back to parsed resume title or suggested roles when target roles are not explicitly set.
 */
export function getEnabledRoles(db: Database.Database): string[] {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as
      | { parsed_json: string }
      | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.parsed_json);
    let roles = parsed?.targets?.roles;
    if (!Array.isArray(roles) || roles.length === 0) {
      if (parsed?.title && typeof parsed.title === 'string' && parsed.title.trim()) {
        roles = [parsed.title.trim()];
      } else if (Array.isArray(parsed?.suggested_roles) && parsed.suggested_roles.length > 0) {
        roles = parsed.suggested_roles;
      }
    }
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
 * Return the user's years of experience from my_profile.parsed_json (supports decimals e.g. 3.1, 3.5).
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
    if (typeof yoe === 'number' && yoe > 0) return yoe;
    if (typeof yoe === 'string') {
      const n = parseFloat(yoe);
      if (!isNaN(n) && n > 0) return n;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Return candidate domain terms from my_profile.parsed_json.
 */
export function getProfileDomainTerms(db: Database.Database): string[] {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as
      | { parsed_json: string }
      | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.parsed_json);
    const terms = [
      ...(Array.isArray(parsed?.domain_terms) ? parsed.domain_terms : []),
      ...(Array.isArray(parsed?.skills) ? parsed.skills : []),
    ];
    return terms
      .filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 2)
      .map((t) => t.trim());
  } catch {
    return [];
  }
}

/**
 * Check if a job text matches candidate's domain priority terms.
 */
export function isDomainPriorityJob(db: Database.Database, text: string): boolean {
  const terms = getProfileDomainTerms(db);
  if (terms.length === 0) return false;
  const lower = (text || '').toLowerCase();
  let count = 0;
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
}

/**
 * Build the final deduplicated search role list.
 * Uses profile roles when available, falls back to defaults.
 */
export function resolveSearchRoles(db: Database.Database, defaults: string[]): string[] {
  const roles = getEnabledRoles(db);
  const base = roles.length ? roles : defaults;
  return Array.from(new Set(base));
}

/**
 * Return candidate's enabled target locations (my_profile.parsed_json.targets.locations).
 */
export function getEnabledLocations(db: Database.Database): string[] {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as
      | { parsed_json: string }
      | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.parsed_json);
    let locs = parsed?.targets?.locations;
    if (!Array.isArray(locs) || locs.length === 0) {
      if (parsed?.location && typeof parsed.location === 'string') {
        locs = [parsed.location];
      }
    }
    if (!Array.isArray(locs)) return [];
    return locs
      .filter((l: unknown): l is string => typeof l === 'string')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

