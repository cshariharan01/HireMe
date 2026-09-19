import {
  matchesPreferredRole,
  isSeniorityCompatible,
  isExperienceCompatible,
  isAutofillCapableUrl,
  isLocationCompatible,
} from './target-job-filter';
import { getRankedMatches, type RankedMatch, INDIA_LOCATIONS_REGEX } from '@/lib/matches';
import { normalizeLocationLabel } from '@/lib/score';
import db from '@/lib/db';

/** Reads the user's apply mode + score threshold from user_settings. */
export function getApplyMode(): { mode: 'smart' | 'all'; threshold: number } {
  try {
    const mode = (db.prepare("SELECT value FROM user_settings WHERE key = 'apply_mode'").get() as { value: string } | undefined)?.value as 'smart' | 'all' ?? 'smart';
    const threshold = parseInt((db.prepare("SELECT value FROM user_settings WHERE key = 'score_threshold'").get() as { value: string } | undefined)?.value ?? '60', 10);
    return { mode, threshold };
  } catch {
    return { mode: 'smart', threshold: 60 };
  }
}

export interface CandidatePreferences {
  yearsOfExperience: number;
  targetRoles: string[];
  targetLocations: string[];
}

export function getCandidatePreferences(): CandidatePreferences {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as
      | { parsed_json: string }
      | undefined;
    if (row?.parsed_json) {
      const p = JSON.parse(row.parsed_json);
      const years = typeof p.yearsOfExperience === 'number' ? p.yearsOfExperience : 3.6;
      const roles = Array.isArray(p.targets?.roles) ? p.targets.roles.filter(Boolean) : [];
      const locations = Array.isArray(p.targets?.locations) ? p.targets.locations.filter(Boolean) : [];
      return { yearsOfExperience: years, targetRoles: roles, targetLocations: locations };
    }
  } catch {}
  return { yearsOfExperience: 3.6, targetRoles: [], targetLocations: [] };
}

export function getCandidateYears(): number {
  return getCandidatePreferences().yearsOfExperience;
}

/**
 * Builds the ranked-match page payload.
 *
 * Extracted from `src/app/api/matches/route.ts` so the ROUTE and the SERVER-RENDERED first paint
 * share one implementation. The dashboard seeds SWR with a server-computed first page, and if that
 * payload's shape ever drifted from the route's, the seed would either be ignored or — worse —
 * render one shape on first paint and a different one after hydration.
 */

export function getMatchPlatform(m: { source: string; sourcePlatform?: string | null; url: string }): string {
  const p = (m.sourcePlatform || m.source || '').toLowerCase();
  const u = (m.url || '').toLowerCase();
  if (p === 'linkedin' || u.includes('linkedin.com')) return 'linkedin';
  if (p === 'naukri' || u.includes('naukri.com')) return 'naukri';
  if (p === 'greenhouse' || u.includes('greenhouse.io') || p === 'ashby' || u.includes('ashbyhq.com') || p === 'lever' || u.includes('lever.co') || p === 'company') {
    return 'direct';
  }
  return p || 'other';
}

interface Filters {
  badge: string | null;
  place: string | null;
  archetype: string | null;
  evaluation: string | null;
  platform: string | null;
  q: string | null;
  includeApplied?: boolean;
  /** Minimum score (0-100). Jobs below this threshold are excluded when Smart Apply mode is on. */
  minScore?: number | null;
}

function matchesFilters(m: RankedMatch, f: Filters, prefs: CandidatePreferences): boolean {
  // Hide applied jobs from active dashboard feed by default (they live in the Tracker)
  if (!f.includeApplied && (m.applied || m.applicationStatus)) {
    return false;
  }

  // Smart Apply mode: exclude jobs below the score threshold.
  // minScore is 0-100 (e.g. 60); m.score is also 0-100.
  if (f.minScore != null && m.score < f.minScore) {
    return false;
  }

  // 1. Dynamic Role Match: filter based on candidate's preferred roles (e.g. from UI profile)
  if (prefs.targetRoles.length > 0 && !matchesPreferredRole(m.title, prefs.targetRoles)) {
    return false;
  }

  // 2. Dynamic Seniority Match: filter based on candidate's experience level (e.g. exclude Lead/Principal/Architect if candidate has 3 YOE)
  if (!isSeniorityCompatible(m.title, prefs.yearsOfExperience, prefs.targetRoles)) {
    return false;
  }

  // 3. Dynamic Experience Match: filter based on candidate's years of experience
  if (
    !isExperienceCompatible(
      m.facts?.experienceMin,
      m.facts?.experienceMax,
      `${m.title} ${m.url} ${m.facts?.experienceText ?? ''}`,
      prefs.yearsOfExperience,
    )
  ) {
    return false;
  }

  // 3. Dynamic Location Match: filter based on candidate's preferred locations
  if (!isLocationCompatible(m.location, m.locationBadge, prefs.targetLocations)) {
    return false;
  }

  // Show only direct application URLs (LinkedIn Easy Apply, Naukri Direct Apply, Ashby, Greenhouse).
  if (!isAutofillCapableUrl(m.url)) return false;

  // Never show external / apply-on-company-site jobs.
  if (m.applyType === 'external') return false;
  if (m.sourcePlatform === 'naukri' && m.applyType !== 'direct_apply') return false;

  // 4. Dynamic UI Entries: filters selected directly in the dashboard UI
  if (f.badge) {
    if (f.badge === 'india') {
      if (m.locationBadge !== 'india' && !INDIA_LOCATIONS_REGEX.test(m.location)) return false;
    } else if (f.badge === 'remote-neutral') {
      if (m.locationBadge !== 'remote-neutral' && m.locationBadge !== 'remote-global') return false;
    } else if (m.locationBadge !== f.badge) {
      return false;
    }
  }
  if (f.platform) {
    const plat = getMatchPlatform(m);
    if (f.platform === 'direct') {
      if (plat === 'linkedin' || plat === 'naukri') return false;
    } else if (plat !== f.platform) {
      return false;
    }
  }
  if (f.place && normalizeLocationLabel(m.location) !== f.place) return false;
  if (f.archetype && m.archetype !== f.archetype) return false;
  if (f.evaluation) {
    if (f.evaluation === 'unevaluated') {
      if (m.evaluation) return false;
    } else if (m.evaluation?.recommendation !== f.evaluation) {
      return false;
    }
  }
  if (f.q) {
    const hay = `${m.company} ${m.title} ${m.location}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

/**
 * Facet counts over the ranked pool. Each facet is counted with the OTHER filters applied but not
 * its own, which is what makes the numbers useful.
 */
function computeFacets(ranked: RankedMatch[], f: Filters, prefs: CandidatePreferences) {
  const without = (key: keyof Filters): RankedMatch[] =>
    ranked.filter((m) => matchesFilters(m, { ...f, [key]: null }, prefs));

  const tally = <T extends string>(rows: RankedMatch[], pick: (m: RankedMatch) => T | null): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const m of rows) {
      const k = pick(m);
      if (k) out[k] = (out[k] || 0) + 1;
    }
    return out;
  };

  const badgeRows = without('badge');
  const archetypeRows = without('archetype');
  const evalRows = without('evaluation');
  const placeRows = without('place');
  const platformRows = without('platform');

  return {
    badge: tally(badgeRows, (m) => m.locationBadge),
    archetype: tally(archetypeRows, (m) => m.archetype),
    evaluation: {
      ...tally(evalRows, (m) => (m.evaluation ? m.evaluation.recommendation : null)),
      unevaluated: evalRows.filter((m) => !m.evaluation).length,
    },
    platform: tally(platformRows, (m) => getMatchPlatform(m)),
    place: tally(placeRows, (m) => normalizeLocationLabel(m.location)),
    // Total for the "All" chip — every filter applied except the one being counted is the wrong
    // basis for this one; "All" means "everything the other filters allow".
    all: ranked.filter((m) => matchesFilters(m, f, prefs)).length,
  };
}

export interface MatchesPageOptions {
  includeHidden?: boolean;
  includeExpired?: boolean;
  includeApplied?: boolean;
  refresh?: boolean;
  limit?: number;
  offset?: number;
  filters?: Partial<Filters>;
  /** When true, apply score threshold from user_settings (Smart Apply mode). */
  applyScoreFilter?: boolean;
}

export type { Filters };

/** Default page size: MATCH_LIMIT (typically 20-50), clamped to 1..200. */
export function defaultPageLimit(): number {
  return Math.min(Math.max(parseInt(process.env.MATCH_LIMIT || '30', 10) || 30, 1), 200);
}

export function buildMatchesPage(o: MatchesPageOptions = {}) {
  const limit = Math.min(Math.max(o.limit ?? defaultPageLimit(), 1), 200);
  const offset = Math.max(o.offset ?? 0, 0);

  // Resolve apply mode: only when caller explicitly passes applyScoreFilter: true.
  // The API route (/api/matches) always sets this; direct calls (tests, server render) don't
  // apply the threshold by default so they see the full pool.
  let resolvedMinScore: number | null = o.filters?.minScore ?? null;
  if (o.applyScoreFilter === true) {
    const { mode, threshold } = getApplyMode();
    if (mode === 'smart') resolvedMinScore = threshold;
  }

  const filters: Filters = {
    badge: o.filters?.badge ?? null,
    place: o.filters?.place ?? null,
    archetype: o.filters?.archetype ?? null,
    evaluation: o.filters?.evaluation ?? null,
    platform: o.filters?.platform ?? null,
    q: o.filters?.q ?? null,
    includeApplied: !!o.includeApplied,
    minScore: resolvedMinScore,
  };

  const result = getRankedMatches({
    includeHidden: !!o.includeHidden,
    includeExpired: !!o.includeExpired,
    includeApplied: !!o.includeApplied,
    refresh: !!o.refresh,
  });
  if (!result) return { error: 'No resume uploaded', matches: [] as RankedMatch[] };

  const prefs = getCandidatePreferences();
  const { ranked, totalEmbedded, hiddenCount } = result;
  const facets = computeFacets(ranked, filters, prefs);
  const filtered = ranked.filter((m) => matchesFilters(m, filters, prefs));

  // Prioritize fresh jobs (ingested within 24h) at the top of the feed
  filtered.sort((a, b) => {
    const aTime = new Date(a.ingestedAt || a.postedAt || 0).getTime();
    const bTime = new Date(b.ingestedAt || b.postedAt || 0).getTime();
    const now = Date.now();
    const aFresh = (now - aTime) < 24 * 3600 * 1000;
    const bFresh = (now - bTime) < 24 * 3600 * 1000;
    if (aFresh && !bFresh) return -1;
    if (!aFresh && bFresh) return 1;
    if (aFresh && bFresh && Math.abs(bTime - aTime) > 3600 * 1000) {
      return bTime - aTime;
    }
    return b.finalScore - a.finalScore;
  });

  const page = filtered.slice(offset, offset + limit);

  return {
    matches: page,
    hiddenCount,
    offset,
    limit,
    hasMore: filtered.length > offset + limit,
    totalEmbedded,
    /** Rows matching the active filters across the WHOLE pool, not just this page. */
    totalFiltered: filtered.length,
    /** Size of the ranked pool the filters and facets are computed over. */
    poolSize: ranked.length,
    facets,
  };
}
