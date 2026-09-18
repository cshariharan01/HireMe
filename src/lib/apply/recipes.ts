// Per-employer application "memory". The external-apply adapters learn how each employer's career
// site works from every attempt — which reveal labels actually opened the form, whether the flow
// is gated behind a manual sign-in or CAPTCHA (so we notify immediately instead of probing), and
// what the last attempt produced. The next apply to the same host starts from the learned labels
// and skips the cold probing.

import db from '../db';

// The default probe order for sites with no recipe yet. Kept in sync with
// `src/lib/apply/linkedin.ts`'s REVEAL_LABELS for fresh sites.
export const DEFAULT_REVEAL_LABELS = [
  'Apply for this job',
  'Start application',
  'Start your application',
  'Apply now',
  'Apply',
  'Continue',
];

export interface ApplyRecipe {
  host: string;
  revealLabels: string[];
  loginRequired: boolean;
  captchaGated: boolean;
  closedPosting: boolean;
  lastOutcome: string | null;
  attempts: number;
  updatedAt: string | null;
}

export function normalizeHost(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./i, '');
  } catch {
    return raw.replace(/^www\./i, '').toLowerCase();
  }
}

/** Read a host's learned recipe (or a default empty one). */
export function getRecipe(host: string): ApplyRecipe {
  const row = db
    .prepare('SELECT reveal_labels, login_required, captcha_gated, closed_posting, last_outcome, attempts, updated_at FROM apply_recipes WHERE host = ?')
    .get(normalizeHost(host)) as Record<string, unknown> | undefined;
  if (!row) {
    return {
      host: normalizeHost(host),
      revealLabels: [...DEFAULT_REVEAL_LABELS],
      loginRequired: false,
      captchaGated: false,
      closedPosting: false,
      lastOutcome: null,
      attempts: 0,
      updatedAt: null,
    };
  }
  let labels: string[] = DEFAULT_REVEAL_LABELS;
  try { labels = JSON.parse(String(row.reveal_labels ?? '[]')) as string[]; } catch { /* keep default */ }
  return {
    host: normalizeHost(host),
    revealLabels: labels.length ? labels : [...DEFAULT_REVEAL_LABELS],
    loginRequired: Boolean(row.login_required),
    captchaGated: Boolean(row.captcha_gated),
    closedPosting: Boolean(row.closed_posting),
    lastOutcome: row.last_outcome ? String(row.last_outcome) : null,
    attempts: Number(row.attempts || 0),
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

export interface RecipeObservation {
  revealLabels?: string[];     // labels that advanced the flow this attempt (in click order)
  loginRequired?: boolean;
  captchaGated?: boolean;
  closedPosting?: boolean;
  outcome?: string;
}

/**
 * Merge a single attempt's observations into the host's recipe. `revealLabels` REPLACES the stored
 * list only when this attempt actually clicked labels that worked — a fresh, richer label order
 * beats a stale one. Boolean gates are OR-accumulated (once seen, remembered).
 */
export function recordApplyAttempt(host: string, obs: RecipeObservation): void {
  const key = normalizeHost(host);
  const recipe = getRecipe(key);
  const mergedLabels =
    obs.revealLabels && obs.revealLabels.length
      ? obs.revealLabels
      : recipe.revealLabels;

  db.prepare(
    `INSERT INTO apply_recipes (host, reveal_labels, login_required, captcha_gated, closed_posting, last_outcome, attempts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(host) DO UPDATE SET
       reveal_labels   = excluded.reveal_labels,
       login_required  = MAX(login_required, excluded.login_required),
       captcha_gated   = MAX(captcha_gated, excluded.captcha_gated),
       closed_posting  = CASE WHEN excluded.closed_posting = 1 THEN 1 ELSE closed_posting END,
       last_outcome    = excluded.last_outcome,
       attempts        = attempts + 1,
       updated_at      = CURRENT_TIMESTAMP`,
  ).run(
    key,
    JSON.stringify(mergedLabels),
    obs.loginRequired ? 1 : recipe.loginRequired ? 1 : 0,
    obs.captchaGated ? 1 : recipe.captchaGated ? 1 : 0,
    obs.closedPosting ? 1 : recipe.closedPosting ? 1 : 0,
    obs.outcome ?? recipe.lastOutcome ?? null,
  );
}

/** All learned recipes, most-recent first — for /api/apply/recipes and the settings UI. */
export function listRecipes(limit = 25): ApplyRecipe[] {
  const rows = db
    .prepare('SELECT host, reveal_labels, login_required, captcha_gated, closed_posting, last_outcome, attempts, updated_at FROM apply_recipes ORDER BY updated_at DESC, rowid DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => {
    let labels: string[] = [];
    try { labels = JSON.parse(String(r.reveal_labels ?? '[]')) as string[]; } catch { /* ignore */ }
    return {
      host: String(r.host),
      revealLabels: labels.length ? labels : [...DEFAULT_REVEAL_LABELS],
      loginRequired: Boolean(r.login_required),
      captchaGated: Boolean(r.captcha_gated),
      closedPosting: Boolean(r.closed_posting),
      lastOutcome: r.last_outcome ? String(r.last_outcome) : null,
      attempts: Number(r.attempts || 0),
      updatedAt: r.updated_at ? String(r.updated_at) : null,
    };
  });
}