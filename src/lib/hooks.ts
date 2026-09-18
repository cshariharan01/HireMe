'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR, { mutate } from 'swr';
import { PAGE_SIZE } from './match-keys';

// Exported so callers can `preload(key, fetcher)` with the SAME fetcher the hooks use —
// preloading with a different one would populate a cache entry SWR then ignores.
export const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// SWR defaults — generous caching since data is single-user and rarely changes per minute.
const baseConfig = {
  dedupingInterval: 30_000, // don't refetch same key within 30s
  revalidateOnFocus: true, // refresh when tab regains focus
  revalidateOnReconnect: true,
  keepPreviousData: true, // show old data instantly while next fetch runs
};

interface GapAnalysis {
  matchedSkills: string[];
  missingKeywords: string[];
}
type LocationBadge = 'india' | 'remote-global' | 'relocation' | 'visa' | 'remote-neutral' | 'us-city' | 'us-only';
export type RoleArchetype = 'Architect' | 'Engineer' | 'Lead' | 'Product' | 'Solutions' | 'Data' | 'DevOps' | 'Other';
export interface PostingFacts {
  salaryText: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: 'INR' | 'USD' | 'GBP' | 'EUR' | null;
  experienceText: string | null;
  experienceMin: number | null;
  experienceMax: number | null;
  workMode: 'remote' | 'hybrid' | 'onsite' | null;
  employmentType: 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary' | null;
}

export interface Match {
  id: number;
  company: string;
  title: string;
  location: string;
  url: string;
  source: string;
  ingestedAt: string;
  postedAt?: string | null;
  domainPriority: number;
  remotePolicy: string | null;
  visaSponsorship: boolean;
  relocationOffered: boolean;
  applyType: 'easy_apply' | 'direct_apply' | 'external' | 'unknown';
  sourcePlatform?: string | null;
  facts: PostingFacts;
  locationBadge: LocationBadge;
  locationReason: string;
  archetype: RoleArchetype;
  ontologyBoost: number;
  rolePenalty: number;
  /** 0..1, equal to `score / 100`. Sort key; `pctClamp(finalScore)` renders `score`. */
  finalScore: number;
  /** Headline 0-100 fit score (bounded composite: retrieval + skill fit + LLM + context). */
  score: number;
  skillFit: { required: string[]; matched: string[]; missing: string[]; missingInTitle: string[]; score: number };
  /** "Why matched" chips, negatives first. */
  reasons: MatchReason[];
  /** Posting age in days, or null when no date is known. */
  ageDays: number | null;
  /** Same role at other locations, collapsed into this row. */
  variants: Array<{ id: number; location: string }>;
  evaluation: { overall_score: number; recommendation: 'apply' | 'consider' | 'skip' } | null;
  legitimacy: 'verified' | 'unknown' | 'caution' | 'suspicious';
  legitimacyReason: string;
  hidden: boolean;
  applied: boolean;
  applicationStatus: 'applied' | 'screening' | 'interview' | 'offer' | 'rejected' | null;
  gapAnalysis: GapAnalysis;
}

export interface MatchReason {
  kind: 'skill-match' | 'skill-gap' | 'domain' | 'role' | 'location' | 'freshness' | 'evaluation' | 'comp' | 'deal-breaker' | 'legitimacy' | 'duplicate';
  label: string;
  tone: 'good' | 'bad' | 'neutral';
}

export interface DigestItem {
  id: number;
  company: string;
  title: string;
  location: string;
  url: string;
  source: string;
  ingestedAt: string;
  score: number;
}

export interface Application {
  id: number;
  job_id: number;
  status: string;
  cover_letter: string | null;
  resume_variant: string | null;
  notes: string | null;
  applied_at: string;
  applied_date: string | null;
  recruiter_name: string | null;
  recruiter_contact: string | null;
  next_follow_up_at: string | null;
  last_status_change_at: string | null;
  company: string;
  title: string;
  location: string;
  url: string;
  has_tailored_resume?: boolean | number;
  tailored_score?: number | null;
  default_score?: number | null;
}

export interface ProfileTargets {
  roles?: string[];
  locations?: string[];
  comp_min?: number;
  comp_max?: number;
  comp_currency?: string;
  must_haves?: string;
  deal_breakers?: string;
}

export interface ProfileShape {
  skills: string[];
  experience: string[];
  education: string[];
  location?: string;
  seniority?: string;
  title?: string;
  yearsOfExperience?: number;
  name?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  targets?: ProfileTargets;
  suggested_roles?: string[];
  domain_terms?: string[];
}

interface MatchesResponse {
  matches?: Match[];
  hiddenCount?: number;
  hasMore?: boolean;
  totalEmbedded?: number;
  /** Rows matching the active filters across the whole ranked pool. */
  totalFiltered?: number;
  poolSize?: number;
  facets?: MatchFacets;
  offset?: number;
  limit?: number;
  error?: string;
}

/** Per-filter availability counts, computed server-side over the whole ranked pool. */
export interface MatchFacets {
  badge: Record<string, number>;
  archetype: Record<string, number>;
  evaluation: Record<string, number>;
  platform?: Record<string, number>;
  place: Record<string, number>;
  all: number;
}

// PAGE_SIZE + the fallback key live in `match-keys.ts` so the SERVER component can import them
// too — this module is client-only, and Next 15 refuses a server->client function call.
export { PAGE_SIZE, matchesFallbackKey } from './match-keys';

export interface MatchFilters {
  badge?: string;
  place?: string;
  archetype?: string;
  eval?: string;
  platform?: string;
  q?: string;
}

/**
 * Filters are sent to the SERVER, not applied to the fetched page. They used to run in the browser
 * over whatever rows had been loaded (30 of a 500-row pool of ~7,000 jobs), which is why most
 * filter chips showed 0 and looked broken. The server applies them across the whole ranked pool
 * and returns `facets` with the counts, so the chips reflect what actually exists.
 */
export function useMatches(includeHidden = false, filters: MatchFilters = {}) {
  // Page 0 is the canonical SWR-cached page; subsequent pages are appended into local state.
  const filterQS = Object.entries(filters)
    .filter(([, v]) => v && v !== 'all')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const baseQS = includeHidden ? '?include_hidden=1' : '';
  const sep = includeHidden ? '&' : '?';
  const firstPageKey = `/api/matches${baseQS}${sep}offset=0&limit=${PAGE_SIZE}${filterQS ? `&${filterQS}` : ''}`;
  const { data, error, isLoading, mutate: m } = useSWR<MatchesResponse>(
    firstPageKey,
    fetcher,
    baseConfig
  );

  // Identifies the active query so a late page from a PREVIOUS filter can be recognised and
  // discarded rather than appended. Updated during render, so after an await it always holds the
  // current key.
  const keyRef = useRef(firstPageKey);
  keyRef.current = firstPageKey;

  const [extraPages, setExtraPages] = useState<Match[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  // Reset extras when SWR-cached first page mutates (e.g., refresh, hide change).
  // We key on includeHidden so toggling Hidden also resets pagination.
  const resetExtras = useCallback(() => {
    setExtraPages([]);
    setExhausted(false);
  }, []);

  // Reset pagination whenever the QUERY ITSELF changes (filters, sort, hidden toggle).
  //
  // Without this, `extraPages` from the PREVIOUS filter stayed in the list: React saw duplicate
  // keys, `currentLength` was inflated so the next page request skipped real rows, and once
  // `exhausted` had been set under one filter it never cleared — "Load more" disappeared for the
  // rest of the session. `firstPageKey` already encodes every input, so it is the right trigger.
  useEffect(() => {
    setExtraPages([]);
    setExhausted(false);
  }, [firstPageKey]);

  const loadMore = useCallback(async () => {
    if (loadingMore || exhausted) return;
    const keyAtStart = firstPageKey;
    const currentLength = (data?.matches?.length || 0) + extraPages.length;
    setLoadingMore(true);
    try {
      const url = `/api/matches${baseQS}${sep}offset=${currentLength}&limit=${PAGE_SIZE}${filterQS ? `&${filterQS}` : ''}`;
      const res = await fetch(url);
      const json = (await res.json()) as MatchesResponse;
      const next = json.matches || [];
      // A page requested under the old filter can land after the key changed; dropping it here
      // stops foreign rows re-entering the list that the effect above just cleared.
      if (keyRef.current !== keyAtStart) return;
      setExtraPages((prev) => [...prev, ...next]);
      if (!json.hasMore || next.length === 0) setExhausted(true);
    } catch {
      // swallow — UI shows generic error
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, exhausted, data?.matches?.length, extraPages.length, baseQS, sep, filterQS, firstPageKey]);

  const allMatches = [...(data?.matches || []), ...extraPages];

  // STABLE IDENTITIES. These three used to be inline arrows inside the returned object literal,
  // i.e. a brand-new function on every render of this hook. The dashboard puts them in
  // `useCallback` dep arrays, so those callbacks were new every render too — which silently made
  // `React.memo(MatchRow)` a no-op and re-rendered all ~30 rows on every keystroke. `m` (SWR's
  // mutate) and `setExtraPages` are stable, so these can be memoised safely.
  const refresh = useCallback(async (...args: Parameters<typeof m>) => {
    // Only reset pagination on full refreshes (no args) — preserve extras across
    // optimistic updates that pass an updater function.
    if (args.length === 0) resetExtras();
    return m(...args);
  }, [m, resetExtras]);

  // Optimistically remove or restore a match across both first-page SWR cache and extras.
  // Used by dashboard hide / unhide so the action works regardless of which page the card is on.
  const removeMatch = useCallback((id: number, hiddenCountDelta = 1) => {
    m((current) => {
      if (!current?.matches) return current;

      const mRow = current.matches.find((mm) => mm.id === id) || extraPages.find((mm) => mm.id === id);
      let updatedFacets = current.facets;
      if (mRow && current.facets) {
        const p = (mRow.sourcePlatform || mRow.source || '').toLowerCase();
        const u = (mRow.url || '').toLowerCase();
        let platKey = 'direct';
        if (p === 'linkedin' || u.includes('linkedin.com')) platKey = 'linkedin';
        else if (p === 'naukri' || u.includes('naukri.com')) platKey = 'naukri';

        const updatedPlatform = current.facets.platform
          ? {
              ...current.facets.platform,
              [platKey]: Math.max(0, (current.facets.platform[platKey] || 0) - 1),
            }
          : undefined;

        const updatedArchetype = (current.facets.archetype && mRow.archetype)
          ? {
              ...current.facets.archetype,
              [mRow.archetype]: Math.max(0, (current.facets.archetype[mRow.archetype] || 0) - 1),
            }
          : current.facets.archetype;

        const updatedBadge = (current.facets.badge && mRow.locationBadge)
          ? {
              ...current.facets.badge,
              [mRow.locationBadge]: Math.max(0, (current.facets.badge[mRow.locationBadge] || 0) - 1),
            }
          : current.facets.badge;

        updatedFacets = {
          ...current.facets,
          ...(updatedPlatform ? { platform: updatedPlatform } : {}),
          archetype: updatedArchetype,
          badge: updatedBadge,
          all: Math.max(0, (current.facets.all || 0) - 1),
        };
      }

      return {
        ...current,
        matches: current.matches.filter((mm) => mm.id !== id),
        hiddenCount: (current.hiddenCount || 0) + hiddenCountDelta,
        totalFiltered: Math.max(0, (current.totalFiltered ?? current.matches.length) - 1),
        facets: updatedFacets,
      };
    }, { revalidate: false });
    setExtraPages((prev) => prev.filter((mm) => mm.id !== id));
  }, [m, extraPages]);

  const updateMatchHidden = useCallback((id: number, hidden: boolean) => {
    m((current) => {
      if (!current?.matches) return current;
      return {
        ...current,
        matches: current.matches.map((mm) => (mm.id === id ? { ...mm, hidden } : mm)),
        hiddenCount: Math.max(0, (current.hiddenCount || 0) + (hidden ? 1 : -1)),
      };
    }, { revalidate: false });
    setExtraPages((prev) => prev.map((mm) => (mm.id === id ? { ...mm, hidden } : mm)));
  }, [m]);

  return {
    matches: allMatches,
    hiddenCount: data?.hiddenCount || 0,
    totalEmbedded: data?.totalEmbedded || 0,
    /** Rows matching the active filters across the whole pool (not just the loaded page). */
    totalFiltered: data?.totalFiltered ?? 0,
    poolSize: data?.poolSize ?? 0,
    /** Server-computed counts per filter value, so chips show real availability. */
    facets: data?.facets,
    hasMore: !exhausted && (data?.hasMore ?? false),
    loadingMore,
    loadMore,
    noResume: data?.error === 'No resume uploaded',
    error: data?.error && data.error !== 'No resume uploaded' ? data.error : error?.message,
    isLoading,
    refresh,
    removeMatch,
    updateMatchHidden,
  };
}

/**
 * Dashboard counts, without fetching the rows they count.
 *
 * The tiles used `useDigest().items.length` and `useApplications().applications.length`, which
 * pulled two full payloads — the applications one carrying every stored cover letter and résumé
 * variant — to render two integers.
 */
export function useDashboardStats() {
  const { data, isLoading } = useSWR<{ freshCount: number; appliedCount: number }>(
    '/api/stats',
    fetcher,
    baseConfig,
  );
  return {
    freshCount: data?.freshCount ?? 0,
    appliedCount: data?.appliedCount ?? 0,
    isLoading,
  };
}

export function useDigest() {
  const { data, isLoading } = useSWR<{ items?: DigestItem[]; error?: string }>('/api/digest', fetcher, baseConfig);
  return { items: data?.items || [], isLoading };
}

export function useProfile() {
  const { data, error, isLoading, mutate: m } = useSWR<{ profile: ProfileShape | null; updatedAt?: string }>(
    '/api/resume',
    fetcher,
    baseConfig
  );
  return {
    profile: data?.profile || null,
    updatedAt: data?.updatedAt || null,
    error: error?.message,
    isLoading,
    refresh: m,
  };
}

export function useApplications() {
  const { data, error, isLoading, mutate: m } = useSWR<{ applications?: Application[] }>(
    '/api/outcomes',
    fetcher,
    baseConfig
  );
  return {
    applications: data?.applications || [],
    error: error?.message,
    isLoading,
    refresh: m,
  };
}

interface JobDetailRes {
  job: {
    id: number;
    source: string;
    company: string;
    title: string;
    location: string;
    description: string;
    descriptionFormatted: string | null;
    url: string;
    domainPriority: number;
    facts: PostingFacts;
    applyType?: 'easy_apply' | 'direct_apply' | 'external' | 'unknown';
    ingestedAt?: string;
    postedAt?: string | null;
  };
  match: {
    ontologyBoost: number;
    finalScore: number;
    applyType?: 'easy_apply' | 'direct_apply' | 'external' | 'unknown';
    /** Bounded 0-100 fit score. Optional because a cached payload written before the composite
     *  scoring landed won't have it. */
    score?: number;
    /** "Why matched" chips, negatives first. */
    reasons?: MatchReason[];
    skillFit?: { required: string[]; matched: string[]; missing: string[]; missingInTitle: string[]; score: number };
    ageDays?: number | null;
    variants?: Array<{ id: number; location: string }>;
    gapAnalysis: GapAnalysis;
  } | null;
  application: {
    status: string;
    cover_letter: string;
    resume_variant: string;
    notes: string;
    applied_date?: string | null;
    recruiter_name?: string | null;
    recruiter_contact?: string | null;
    next_follow_up_at?: string | null;
  } | null;
}

export function useJobDetail(jobId: string | number | undefined) {
  const { data, error, isLoading, mutate: m } = useSWR<JobDetailRes>(
    jobId ? `/api/matches/${jobId}` : null,
    fetcher,
    baseConfig
  );
  return { data, error: error?.message, isLoading, refresh: m };
}

// Cross-component invalidation helpers.
// The matches list is keyed with a query string (`/api/matches?offset=…`), so a plain
// mutate('/api/matches') wouldn't match it — use a prefix filter. The trailing `?` keeps this
// from also revalidating the per-job detail keys (`/api/matches/123`).
export const revalidateMatches = () =>
  mutate((key) => typeof key === 'string' && (key.startsWith('/api/matches?') || key === '/api/matches'), undefined, { revalidate: true });
export const revalidateDigest = () => mutate('/api/digest');
export const revalidateApplications = () => {
  mutate('/api/outcomes');
  mutate('/api/stats');
};
export const revalidateDashboardStats = () => mutate('/api/stats');
export const revalidateProfile = () => mutate('/api/resume');
export const revalidateJobDetail = (jobId: string | number) => mutate(`/api/matches/${jobId}`);
