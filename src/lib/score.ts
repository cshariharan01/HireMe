// Centralized match-score helpers. Previously duplicated across the dashboard + job detail.
//
// `finalScore` is now `score / 100` from the bounded composite in src/lib/relevance.ts, so it can
// no longer exceed 1.0 and the clamp below is a safety net rather than load-bearing. It used to be
// `cosine + stacked boosts`, which DID overflow — and the clamp then collapsed seven unrelated
// jobs to an identical "100%", destroying the ordering between them. Tier thresholds are tuned to
// the composite's real distribution (measured on the live corpus: max 84, median 37).

export type ScoreTier = 'high' | 'good' | 'fair' | 'low';

export function pctClamp(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score * 100)));
}

/**
 * Tier thresholds, CALIBRATED to the composite's real distribution.
 *
 * The previous cut-offs (80 / 65 / 50) were inherited from the old unbounded `cosine + boosts`
 * score, where everything plausible read 70-99. The bounded composite lives in a completely
 * different range, and against the live corpus those thresholds put **95.1% of jobs in "low"** with
 * just 3 rows out of 1,006 reaching "high" — so every filtered view rendered as an undifferentiated
 * wall of grey, which is exactly the complaint.
 *
 * Measured on 1,006 ranked rows: min 0, median 32, p75 39, p90 47, p95 54, max 80. These cut-offs
 * are the p95 / p85 / p50 points, giving roughly 5% high · 10% good · 32% fair · 53% low — a
 * distribution where the badge actually discriminates.
 *
 * They are FIXED rather than recomputed per pool on purpose: a relative tier would make the same
 * job change colour depending on what else was loaded. Re-derive them (and update these numbers)
 * whenever the scoring model changes materially — `SCORING_VERSION` in matches.ts is the signal.
 */
const TIER_HIGH = 55;
const TIER_GOOD = 45;
const TIER_FAIR = 33;

export function scoreTier(score: number): ScoreTier {
  const pct = pctClamp(score);
  if (pct >= TIER_HIGH) return 'high';
  if (pct >= TIER_GOOD) return 'good';
  if (pct >= TIER_FAIR) return 'fair';
  return 'low';
}

// Tailwind classes per tier (chip style: tinted bg + text + border).
export const TIER_CHIP: Record<ScoreTier, string> = {
  high: 'bg-success/15 text-success border-success/30',
  good: 'bg-info/15 text-info border-info/30',
  fair: 'bg-warning/15 text-warning border-warning/30',
  low: 'bg-muted text-muted-foreground border-border',
};

// Solid dot/ring color per tier (for avatars / rings).
export const TIER_SOLID: Record<ScoreTier, string> = {
  high: 'text-success',
  good: 'text-info',
  fair: 'text-warning',
  low: 'text-muted-foreground',
};

export function companyInitials(name: string): string {
  return (
    name
      .split(/[\s-_]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('') || '?'
  );
}

/**
 * Collapse a free-text job location to a short, dropdown-friendly label: the city (first segment
 * before a comma), or "Remote" for bare remote postings. Keeps the Place dropdown compact instead
 * of listing every "City, State, Country" spelling variant as its own entry.
 *
 * Lives here (rather than in the dashboard) because /api/matches now filters by place SERVER-side
 * and must group locations identically to the client that renders the options.
 */
export function normalizeLocationLabel(loc: string): string {
  const s = (loc || '').trim();
  if (!s) return 'Unspecified';
  if (/^remote/i.test(s) || (/remote/i.test(s) && !s.includes(','))) return 'Remote';
  // Strip purely-administrative suffixes (e.g. "Pune Division", "Pune District") so they fold into
  // the base city. Intentionally NOT stripping "City" — that's often part of the real name
  // ("Kansas City", "Jersey City"), and merging it would be wrong.
  const first = s.split(',')[0].trim().replace(/\s+(division|district)$/i, '').trim();
  return first || s;
}
