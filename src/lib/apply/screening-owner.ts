// Profile-scoped ownership for the screening-answer cache.
//
// The app is single-user and the SQLite file is local, but the DB (or a copy of
// it) can travel between users — a friend onboarding from a shared setup, a
// restored backup, a copied data dir. `screening_answers` used to be keyed ONLY
// by a hash of the question text, so a new user's applications silently reused
// the previous owner's answers (work-auth, CTC, location — the hazardous ones).
//
// Two mechanisms keep the cache per-profile:
//   1. `screeningOwnerId()` + `hashScreeningQuestion()` — the question hash is
//      salted with the active profile's identity (email, else name), so rows
//      written by one profile never match lookups from another.
//   2. `ensureScreeningOwner()` — when the active identity changes (new resume
//      uploaded, different user), the previous owner's rows are wiped, so they
//      are neither served nor visible through the API. Same profile → no-op.

import { createHash } from 'crypto';
import db from '../db';

/** Identity string for the profile that owns cached screening answers. */
export function screeningOwnerId(profile: Record<string, unknown>): string {
  const id = (profile.email as string) || (profile.name as string) || 'default';
  return String(id).toLowerCase().trim() || 'default';
}

/** sha256 of the normalized question, salted with the owning profile id. */
export function hashScreeningQuestion(question: string, ownerId: string): string {
  const norm = question.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${ownerId}|${norm}`).digest('hex').slice(0, 24);
}

const OWNER_KEY = 'screening_owner';

/**
 * Drop the previous owner's cached answers when the active profile identity
 * changes. Failures are swallowed: scoping via the salted hash still holds
 * even if the wipe cannot run.
 */
export function ensureScreeningOwner(ownerId: string): void {
  try {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(OWNER_KEY) as
      | { value: string }
      | undefined;
    if (!row) {
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(OWNER_KEY, ownerId);
      return;
    }
    if (row.value !== ownerId) {
      db.prepare('DELETE FROM screening_answers').run();
      db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run(ownerId, OWNER_KEY);
    }
  } catch {
    // app_meta unavailable — the salted hash still isolates profiles.
  }
}
