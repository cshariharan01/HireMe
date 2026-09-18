// Shared helper: resolve whether junior/early-career roles should be KEPT for this user.
//
// Safe to import from scripts — takes an already-open better-sqlite3 handle and only runs a
// SELECT (no auto-schema side effects, unlike importing src/lib/db.ts). Mirrors profile-roles.ts.
//
// Drives the experience-aware seniority gate (src/lib/seniority.ts isSeniorRelevant): a
// senior candidate keeps the default (junior titles dropped as noise); an early-career
// candidate (few years of experience, or a junior/mid seniority label) keeps them.

import type Database from 'better-sqlite3';

const JUNIOR_LABEL_RE = /\b(junior|jr|entry|associate|fresher|graduate|trainee|intern|mid|mid[- ]?level)\b/i;

/**
 * True when junior/early-career roles should be kept for this user. Based on the resume's
 * parsed yearsOfExperience (< 6 ⇒ keep) or a junior/mid seniority label. Defaults to FALSE
 * (senior behaviour) when there's no profile or it can't be read — preserving prior behaviour.
 */
export function resolveAllowJunior(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as
      | { parsed_json: string }
      | undefined;
    if (!row) return false;
    const p = JSON.parse(row.parsed_json);
    const yrs = typeof p.yearsOfExperience === 'number' ? p.yearsOfExperience : null;
    if (yrs != null) return yrs < 6;
    return JUNIOR_LABEL_RE.test(String(p.seniority || p.title || ''));
  } catch {
    return false;
  }
}
