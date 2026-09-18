'use client';

import { Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Building2, Globe2, MapPin, Plane, RefreshCw, Search, Sparkles, Target, TrendingUp,
  CheckCircle2, AlertTriangle, Loader2, ThumbsUp, ThumbsDown, CircleHelp, Wand2, X,
  Eye, EyeOff, Bookmark, BookmarkPlus, Clock, Play, Pause, Square, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ScoreBadge } from '@/components/ui/score-badge';
import { cn, formatJobAge } from '@/lib/utils';
import { companyInitials, normalizeLocationLabel } from '@/lib/score';
import Link from 'next/link';
import { toast } from 'sonner';
import { preload, SWRConfig } from 'swr';
import { useMatches, useDashboardStats, revalidateDashboardStats, revalidateMatches, revalidateApplications, revalidateDigest, fetcher, type Match, type RoleArchetype } from '@/lib/hooks';
import { useDebouncedValue } from '@/lib/use-debounce';
import { JobDetailPanel } from '@/components/job-detail-panel';
import { OnboardingBanner } from '@/components/onboarding-banner';

type LocationBadge = 'india' | 'remote-global' | 'relocation' | 'visa' | 'remote-neutral' | 'us-city' | 'us-only';

const BADGE_CONFIG: Record<LocationBadge, { label: string; variant: 'success' | 'info' | 'muted' | 'warning' | 'destructive'; icon: typeof Globe2 }> = {
  india: { label: 'India', variant: 'success', icon: MapPin },
  'remote-global': { label: 'Remote · Global', variant: 'success', icon: Globe2 },
  relocation: { label: 'Relocation', variant: 'info', icon: Plane },
  visa: { label: 'Visa sponsor', variant: 'info', icon: CheckCircle2 },
  'remote-neutral': { label: 'Remote', variant: 'muted', icon: Globe2 },
  'us-city': { label: 'US city', variant: 'warning', icon: AlertTriangle },
  'us-only': { label: 'US only', variant: 'destructive', icon: AlertTriangle },
};

const EVAL_ICON = { apply: ThumbsUp, consider: CircleHelp, skip: ThumbsDown } as const;

// Application-status → badge style. Shown on rows for jobs you've already applied to / are in a
// pipeline for, so applied jobs are obvious in the list even when kept visible.
const APPLIED_BADGE: Record<string, { label: string; variant: 'success' | 'info' | 'warning' | 'destructive' }> = {
  applied: { label: 'Applied Successfully', variant: 'success' },
  screening: { label: 'Screening', variant: 'info' },
  interview: { label: 'Interview', variant: 'info' },
  offer: { label: 'Offer', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'destructive' },
};

const APPLY_TYPE_BADGE: Record<Match['applyType'], { label: string; variant: 'info' | 'warning' | 'muted' }> = {
  easy_apply: { label: 'Easy Apply', variant: 'info' },
  direct_apply: { label: 'Direct Apply', variant: 'warning' },
  external: { label: 'External', variant: 'muted' },
  unknown: { label: 'Apply type unknown', variant: 'muted' },
};

const PLATFORM_BADGE: Record<string, { label: string; variant: 'info' | 'muted' }> = {
  linkedin: { label: 'LinkedIn', variant: 'info' },
  naukri: { label: 'Naukri', variant: 'info' },
  indeed: { label: 'Indeed', variant: 'info' },
};

function resolvePlatformBadge(m: Match): { label: string; variant: 'info' | 'muted' } | null {
  const url = (m.url || '').toLowerCase();
  const source = (m.source || '').toLowerCase();
  const platform = (m.sourcePlatform || '').toLowerCase();

  if (platform === 'linkedin' || source === 'linkedin' || url.includes('linkedin.com')) {
    return PLATFORM_BADGE.linkedin;
  }
  if (platform === 'naukri' || source === 'naukri' || url.includes('naukri.com')) {
    return PLATFORM_BADGE.naukri;
  }
  if (platform === 'indeed' || source === 'indeed' || url.includes('indeed.com')) {
    return PLATFORM_BADGE.indeed;
  }
  return PLATFORM_BADGE[source] || null;
}

function isDesktop() {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
}

/**
 * Client entry for the dashboard.
 *
 * `fallback` carries a SERVER-COMPUTED first page of matches, keyed exactly as `useMatches` keys
 * its own request. SWR renders it synchronously on the first paint, so the list is on screen
 * immediately instead of a skeleton followed by a fetch. The key must match `firstPageKey` in
 * hooks.ts character-for-character or the seed is silently ignored — `matchesFallbackKey()` is
 * shared by both sides so they cannot drift.
 */
export default function DashboardClient({ fallback }: { fallback?: Record<string, unknown> }) {
  // useSearchParams (below) needs a Suspense boundary for the build's CSR bailout.
  return (
    <SWRConfig value={{ fallback: fallback ?? {} }}>
      <Suspense fallback={<div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>}>
        <Dashboard />
      </Suspense>
    </SWRConfig>
  );
}

function Dashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobParam = searchParams.get('job');

  const [showHidden, setShowHidden] = useState(false);
  // Declared before useMatches so the filters can be sent to the server. Filtering happens
  // SERVER-side over the whole ranked pool — see the comment on useMatches. The local `filtered`
  // memo below still runs, but it now only sorts and acts as a no-op safety net over rows the
  // server has already filtered.
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const [badgeFilter, setBadgeFilter] = useState<LocationBadge | 'all'>('all');
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const [archetypeFilter, setArchetypeFilter] = useState<RoleArchetype | 'all'>('all');
  const [evalFilter, setEvalFilter] = useState<'all' | 'apply' | 'consider' | 'skip' | 'unevaluated'>('all');

  const {
    matches, hiddenCount, totalEmbedded, totalFiltered, facets, hasMore, loadingMore, loadMore,
    noResume, error, isLoading, refresh: refreshMatches, removeMatch, updateMatchHidden,
  } = useMatches(showHidden, {
    badge: badgeFilter,
    place: locationFilter,
    archetype: archetypeFilter,
    eval: evalFilter,
    platform: platformFilter,
    q: debouncedQuery.trim(),
  });
  // Counts only — see `useDashboardStats`. Fetching the digest ITEMS and every application row
  // just to read `.length` was two full payloads for two integers.
  const { freshCount, appliedCount } = useDashboardStats();

  const [refreshing, setRefreshing] = useState(false);
  type SortKey = 'score' | 'eval' | 'recent' | 'company' | 'location';
  const [sortBy, setSortBy] = useState<SortKey>('score');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(jobParam ? Number(jobParam) : null);
  useEffect(() => { if (jobParam) setSelectedId(Number(jobParam)); }, [jobParam]);

  // Saved searches
  type SavedSearch = { name: string; query: string; badgeFilter: LocationBadge | 'all'; platformFilter?: string; archetypeFilter: RoleArchetype | 'all'; evalFilter: 'all' | 'apply' | 'consider' | 'skip' | 'unevaluated'; sortBy: SortKey; locationFilter?: string; };
  const SAVED_KEY = 'hs:savedSearches';
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { const raw = localStorage.getItem(SAVED_KEY); if (raw) setSavedSearches(JSON.parse(raw)); } catch { /* ignore */ }
  }, []);
  const persistSaved = (next: SavedSearch[]) => { setSavedSearches(next); try { localStorage.setItem(SAVED_KEY, JSON.stringify(next)); } catch { /* ignore */ } };
  const saveCurrentSearch = () => {
    const name = saveName.trim(); if (!name) return;
    persistSaved([...savedSearches.filter((s) => s.name !== name), { name, query, badgeFilter, platformFilter, archetypeFilter, evalFilter, sortBy, locationFilter }]);
    setShowSaveDialog(false); setSaveName(''); toast.success(`Saved "${name}"`);
  };
  const applySaved = (s: SavedSearch) => { setQuery(s.query); setBadgeFilter(s.badgeFilter); setPlatformFilter(s.platformFilter ?? 'all'); setArchetypeFilter(s.archetypeFilter); setEvalFilter(s.evalFilter); setLocationFilter(s.locationFilter ?? 'all'); setSortBy(s.sortBy); toast.success(`Applied "${s.name}"`); };
  const removeSaved = (name: string) => { persistSaved(savedSearches.filter((s) => s.name !== name)); };

  const anyFilterActive = query.length > 0 || badgeFilter !== 'all' || platformFilter !== 'all' || archetypeFilter !== 'all' || evalFilter !== 'all' || locationFilter !== 'all' || sortBy !== 'score';
  const clearAllFilters = () => { setQuery(''); setBadgeFilter('all'); setPlatformFilter('all'); setArchetypeFilter('all'); setEvalFilter('all'); setLocationFilter('all'); setSortBy('score'); };

  const [bulkEvalProgress, setBulkEvalProgress] = useState<{ current: number; total: number } | null>(null);
  const bulkCancelRef = useRef(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await refreshMatches(); toast.success('Matches refreshed'); }
    catch { toast.error('Refresh failed'); }
    finally { setRefreshing(false); }
  };

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const list = matches.filter((m) => {
      if (badgeFilter !== 'all') {
        if (badgeFilter === 'remote-neutral') {
          if (m.locationBadge !== 'remote-neutral' && m.locationBadge !== 'remote-global') return false;
        } else if (m.locationBadge !== badgeFilter) {
          return false;
        }
      }
      if (platformFilter !== 'all') {
        const p = (m.sourcePlatform || m.source || '').toLowerCase();
        const u = (m.url || '').toLowerCase();
        if (platformFilter === 'linkedin') {
          if (p !== 'linkedin' && !u.includes('linkedin.com')) return false;
        } else if (platformFilter === 'naukri') {
          if (p !== 'naukri' && !u.includes('naukri.com')) return false;
        } else if (platformFilter === 'direct') {
          if (p === 'linkedin' || u.includes('linkedin.com') || p === 'naukri' || u.includes('naukri.com')) return false;
        }
      }
      if (locationFilter !== 'all' && normalizeLocationLabel(m.location) !== locationFilter) return false;
      if (archetypeFilter !== 'all' && m.archetype !== archetypeFilter) return false;
      if (evalFilter !== 'all') {
        if (evalFilter === 'unevaluated') { if (m.evaluation) return false; }
        else { if (!m.evaluation || m.evaluation.recommendation !== evalFilter) return false; }
      }
      if (!q) return true;
      return m.company.toLowerCase().includes(q) || m.title.toLowerCase().includes(q) || m.location.toLowerCase().includes(q);
    });
    const sorted = [...list];
    switch (sortBy) {
      case 'eval': sorted.sort((a, b) => (b.evaluation?.overall_score ?? -1) - (a.evaluation?.overall_score ?? -1)); break;
      case 'recent': sorted.sort((a, b) => new Date(b.ingestedAt).getTime() - new Date(a.ingestedAt).getTime()); break;
      case 'company': sorted.sort((a, b) => a.company.localeCompare(b.company)); break;
      case 'location': sorted.sort((a, b) => (a.location || '').localeCompare(b.location || '')); break;
      case 'score': default: sorted.sort((a, b) => b.finalScore - a.finalScore);
    }
    return sorted;
  }, [matches, debouncedQuery, badgeFilter, platformFilter, archetypeFilter, evalFilter, sortBy, locationFilter]);

  // Distinct places present in the loaded matches, most-common first — powers the Place dropdown.
  const locationOptions = useMemo(() => {
    if (facets?.place) return Object.entries(facets.place).sort((a, b) => b[1] - a[1]);
    const counts = new Map<string, number>();
    for (const m of matches) {
      const label = normalizeLocationLabel(m.location);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [facets, matches]);

  // Persist filtered IDs for prev/next nav from the job detail route.
  //
  // DEFERRED, not synchronous. This serialises every visible id to sessionStorage — a blocking
  // main-thread write — and `filtered` changes on every keystroke in the search box, so it ran on
  // the typing path for no benefit: nothing reads this value until the user opens a job. An idle
  // callback moves it off the critical path, and the timeout guarantees it still lands.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const write = () => {
      try { sessionStorage.setItem('hs:visibleMatchIds', JSON.stringify(filtered.map((m) => m.id))); } catch { /* ignore */ }
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    if (typeof w.requestIdleCallback === 'function') {
      const handle = w.requestIdleCallback(write, { timeout: 500 });
      return () => w.cancelIdleCallback?.(handle);
    }
    const t = setTimeout(write, 200); // Safari has no requestIdleCallback
    return () => clearTimeout(t);
  }, [filtered]);

  // Auto-select the top match on desktop when nothing is selected.
  useEffect(() => {
    if (selectedId == null && filtered.length && isDesktop()) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  // Memoised so `MatchRow`'s React.memo can actually skip work. As a plain function this was a new
  // object every render, which made the `handleRowSelect` useCallback below produce a new function
  // too — so every row re-rendered on every keystroke and the memo did nothing at all.
  const selectMatch = useCallback((m: Match) => {
    if (!isDesktop()) { router.push(`/job/${m.id}`); return; }
    setSelectedId(m.id);
    try { const u = new URL(window.location.href); u.searchParams.set('job', String(m.id)); window.history.replaceState(null, '', u.toString()); } catch { /* ignore */ }
  }, [router]);

  // Keyboard nav: j/k move, e/Enter open, h/x hide, / focus search
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  useEffect(() => { if (focusedIdx >= filtered.length) setFocusedIdx(filtered.length > 0 ? 0 : -1); }, [filtered.length, focusedIdx]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput = !!target?.closest('input, textarea, [contenteditable="true"], select');
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' && !inInput) { e.preventDefault(); searchInputRef.current?.focus(); return; }
      if (inInput) return;
      if (e.key === 'j') { e.preventDefault(); setFocusedIdx((i) => Math.min(filtered.length - 1, i < 0 ? 0 : i + 1)); }
      else if (e.key === 'k') { e.preventDefault(); setFocusedIdx((i) => Math.max(0, i < 0 ? 0 : i - 1)); }
      else if (e.key === 'e' || e.key === 'Enter') { if (focusedIdx >= 0 && focusedIdx < filtered.length) { e.preventDefault(); selectMatch(filtered[focusedIdx]); } }
      else if (e.key === 'h' || e.key === 'x') { if (focusedIdx >= 0 && focusedIdx < filtered.length) { e.preventDefault(); const m = filtered[focusedIdx]; if (!m.hidden) hideMatch(m); else unhideMatch(m); } }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, focusedIdx]);
  useEffect(() => {
    if (focusedIdx < 0) return;
    const id = filtered[focusedIdx]?.id; if (!id) return;
    document.getElementById(`match-row-${id}`)?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx, filtered]);

  type ApplyMode = 'manual' | 'auto';
  const [applyMode, setApplyModeState] = useState<'manual' | 'auto'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('hs_apply_mode');
      if (saved === 'auto' || saved === 'manual') return saved;
    }
    return 'manual';
  });

  const setApplyMode = useCallback((mode: 'manual' | 'auto') => {
    setApplyModeState(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('hs_apply_mode', mode);
    }
  }, []);

  const [autoApplyRunning, setAutoApplyRunning] = useState(false);
  const [autoApplyPaused, setAutoApplyPaused] = useState(false);

  useEffect(() => {
    if (autoApplyRunning) {
      setApplyMode('auto');
    }
  }, [autoApplyRunning, setApplyMode]);

  interface AutoApplyProgress {
    current: number;
    total: number;
    company: string;
    title: string;
    stepText: string;
  }
  const [autoApplyProgress, setAutoApplyProgress] = useState<AutoApplyProgress | null>(null);
  const [autoApplyStatusMessage, setAutoApplyStatusMessage] = useState<string>('');

  const autoApplyStopRef = useRef(false);
  const autoApplyPausedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const currentFilteredIndex = useMemo(() => {
    if (!selectedId) return -1;
    return filtered.findIndex((m) => m.id === selectedId);
  }, [filtered, selectedId]);

  const stopAutoApply = useCallback(() => {
    autoApplyStopRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setAutoApplyRunning(false);
    setAutoApplyPaused(false);
    setAutoApplyStatusMessage('');
    setAutoApplyProgress(null);
    void fetch('/api/apply/focus-browser', { method: 'DELETE' }).catch(() => {});
    toast('Auto-Apply runner stopped.');
  }, []);

  const pauseAutoApply = useCallback(() => {
    autoApplyPausedRef.current = true;
    setAutoApplyPaused(true);
    toast('Auto-Apply paused.');
  }, []);

  const resumeAutoApply = useCallback(() => {
    autoApplyPausedRef.current = false;
    setAutoApplyPaused(false);
    toast('Auto-Apply resumed.');
  }, []);

  const startAutoApply = useCallback(async () => {
    if (filtered.length === 0) {
      toast.error('No matched jobs in the current list to apply');
      return;
    }
    autoApplyStopRef.current = false;
    autoApplyPausedRef.current = false;
    setAutoApplyRunning(true);
    setAutoApplyPaused(false);

    const queue = [...filtered];
    const totalJobs = queue.length;
    const startIdx = currentFilteredIndex >= 0 ? currentFilteredIndex : 0;
    toast.success(`Starting Auto-Apply queue from job ${startIdx + 1} of ${totalJobs}...`);

    for (let i = startIdx; i < queue.length; i++) {
      if (autoApplyStopRef.current) break;

      while (autoApplyPausedRef.current) {
        if (autoApplyStopRef.current) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (autoApplyStopRef.current) break;

      const job = queue[i];
      setFocusedIdx(i);
      setSelectedId(job.id);
      try { const u = new URL(window.location.href); u.searchParams.set('job', String(job.id)); window.history.replaceState(null, '', u.toString()); } catch { /* ignore */ }

      // Animated multi-stage progress description
      const STAGES = [
        'Analyzing job requirements & submission plan',
        'Tailoring résumé with AI & matching skills',
        'Opening Chrome browser & navigating to portal',
        'Auto-filling form fields & submitting',
      ];

      const updateStageStatus = (stageIdx: number) => {
        if (autoApplyStopRef.current) return;
        const text = STAGES[stageIdx];
        setAutoApplyStatusMessage(text);
        setAutoApplyProgress({
          current: i + 1,
          total: totalJobs,
          company: job.company,
          title: job.title,
          stepText: text,
        });
      };

      updateStageStatus(0);
      const stageTimeouts = [
        setTimeout(() => updateStageStatus(1), 3500),
        setTimeout(() => updateStageStatus(2), 8500),
        setTimeout(() => updateStageStatus(3), 16000),
      ];
      const clearStageTimeouts = () => stageTimeouts.forEach(clearTimeout);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const res = await fetch(`/api/jobs/${job.id}/apply?auto_submit=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoSubmit: true }),
          signal: controller.signal,
        });

        clearStageTimeouts();
        abortControllerRef.current = null;

        if (autoApplyStopRef.current || res.status === 499) {
          break;
        }

        const json = await res.json();

        const isAlreadyApplied = Boolean(
          json.alreadyApplied ||
          json.response?.platformStatus === 'already_applied' ||
          json.error?.toLowerCase().includes('already applied')
        );

        const isSubmitted = Boolean(
          json.ok ||
          json.response?.submitted ||
          json.unconfirmed ||
          json.readyForSubmit ||
          json.response?.readyForSubmit ||
          isAlreadyApplied
        );

        if (isSubmitted) {
          removeMatch(job.id, 0);
          setSelectedId((prev) => (prev === job.id ? null : prev));
          revalidateApplications();
          revalidateMatches();
          revalidateDashboardStats();
          revalidateDigest();

          const label = isAlreadyApplied
            ? `Already applied on platform!`
            : `Submitted application!`;
          const msg = `${label} Moved to Tracker. Switching to next job...`;
          setAutoApplyStatusMessage(msg);
          setAutoApplyProgress({
            current: i + 1,
            total: totalJobs,
            company: job.company,
            title: job.title,
            stepText: msg,
          });
          toast.success(`${job.company}: ${label} Moved to Tracker.`);
          await new Promise((r) => setTimeout(r, 2500));
        } else if (json.stoppedForReview) {
          revalidateApplications();
          revalidateMatches();
          revalidateDashboardStats();
          revalidateDigest();
          const msg = `Form filled in Chrome (review required). Waiting 5s before next job...`;
          setAutoApplyStatusMessage(msg);
          setAutoApplyProgress({
            current: i + 1,
            total: totalJobs,
            company: job.company,
            title: job.title,
            stepText: msg,
          });
          toast.info(`Review required in Chrome for ${job.company}. Switching to next job...`, { duration: 4000 });
          for (let s = 0; s < 5; s++) {
            if (autoApplyStopRef.current) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
        } else {
          const msg = `${json.error || 'Skipped'}. Switching to next job...`;
          setAutoApplyStatusMessage(msg);
          setAutoApplyProgress({
            current: i + 1,
            total: totalJobs,
            company: job.company,
            title: job.title,
            stepText: msg,
          });
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err: any) {
        clearStageTimeouts();
        abortControllerRef.current = null;
        if (err?.name === 'AbortError' || autoApplyStopRef.current) {
          break;
        }
        const msg = `Error: ${err?.message || 'Application error'}. Switching to next job...`;
        setAutoApplyStatusMessage(msg);
        setAutoApplyProgress({
          current: i + 1,
          total: totalJobs,
          company: job.company,
          title: job.title,
          stepText: msg,
        });
        await new Promise((r) => setTimeout(r, 2000));
      }

      void refreshMatches();
    }

    setAutoApplyRunning(false);
    setAutoApplyPaused(false);
    setAutoApplyStatusMessage('');
    setAutoApplyProgress(null);
    void fetch('/api/apply/focus-browser', { method: 'DELETE' }).catch(() => {});
    revalidateApplications();
    revalidateMatches();
    revalidateDashboardStats();
    revalidateDigest();
    if (!autoApplyStopRef.current) {
      toast.success('Auto-Apply queue finished! All jobs processed.');
    }
  }, [currentFilteredIndex, filtered, refreshMatches, removeMatch]);

  const handleNextAutoApply = useCallback(() => {
    if (filtered.length === 0) return;
    const nextIdx = (currentFilteredIndex >= 0 ? currentFilteredIndex : 0) + 1;
    if (nextIdx < filtered.length) {
      const nextMatch = filtered[nextIdx];
      setFocusedIdx(nextIdx);
      selectMatch(nextMatch);
      toast.info(`Moved to job ${nextIdx + 1} of ${filtered.length}: ${nextMatch.company}`);
    } else {
      setAutoApplyRunning(false);
      toast.success('Auto-apply queue completed! All jobs in view processed.');
    }
  }, [currentFilteredIndex, filtered, selectMatch]);

  const handlePrevAutoApply = useCallback(() => {
    if (filtered.length === 0) return;
    const prevIdx = Math.max(0, (currentFilteredIndex >= 0 ? currentFilteredIndex : 0) - 1);
    const prevMatch = filtered[prevIdx];
    setFocusedIdx(prevIdx);
    selectMatch(prevMatch);
  }, [currentFilteredIndex, filtered, selectMatch]);

  // Server-computed over the WHOLE ranked pool. Previously counted the ~30 loaded rows, which is
  // why chips like "Skip 0" / "Visa 0" rendered disabled even when such jobs existed.
  const evalCounts = useMemo(() => {
    const f = facets?.evaluation;
    return {
      all: facets?.all ?? matches.length,
      apply: f?.apply ?? 0,
      consider: f?.consider ?? 0,
      skip: f?.skip ?? 0,
      unevaluated: f?.unevaluated ?? 0,
    };
  }, [facets, matches.length]);
  const filteredUnevaluatedCount = useMemo(() => filtered.filter((m) => !m.evaluation).length, [filtered]);

  // Warm the detail payload on hover/focus, before the click.
  //
  // There was no prefetching anywhere in this app: the detail request only started once the row was
  // clicked, so the panel's latency was fully exposed. SWR's `preload` populates the very cache key
  // `useJobDetail` reads, so an already-hovered row renders from cache on click. Deduped by SWR,
  // so repeated hovers cost one request.
  const prefetchJob = useCallback((id: number) => {
    if (!id || typeof id !== 'number') return;
    try {
      preload(`/api/matches/${id}`, fetcher).catch(() => {});
    } catch {
      // Prefetching is an optimization — network or server hiccups should never crash the UI
    }
  }, []);

  // Stable identities so `MatchRow` can be memoised — inline arrow props would give every row a new
  // function on each keystroke and defeat React.memo entirely.
  const handleRowSelect = useCallback((m: Match, i: number) => {
    setFocusedIdx(i);
    selectMatch(m);
  }, [selectMatch]);

  const bulkEvaluate = async (limit = 30) => {
    const candidates = filtered.filter((m) => !m.evaluation).slice(0, limit);
    if (candidates.length === 0) { toast('No unevaluated matches in the current view'); return; }
    bulkCancelRef.current = false;
    setBulkEvalProgress({ current: 0, total: candidates.length });
    // Count the three outcomes separately. This loop used to ignore `res.ok` entirely and just
    // increment on every iteration, so a run where every single request 409'd or 500'd still
    // reported "Evaluated 30 jobs" — the toast was measuring attempts, not results.
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let attempted = 0;
    for (const m of candidates) {
      if (bulkCancelRef.current) break;
      try {
        const res = await fetch(`/api/jobs/${m.id}/evaluate`, { method: 'POST' });
        if (res.ok) ok++;
        else if (res.status === 409) skipped++; // already applied — deliberate, not an error
        else failed++;
      } catch {
        failed++;
      }
      attempted++;
      setBulkEvalProgress({ current: attempted, total: candidates.length });
    }
    setBulkEvalProgress(null);

    const parts = [`${ok} rated`];
    if (skipped) parts.push(`${skipped} skipped (already applied)`);
    if (failed) parts.push(`${failed} failed`);
    const summary = parts.join(' · ');
    if (bulkCancelRef.current) toast.message(`Stopped after ${attempted} of ${candidates.length} — ${summary}`);
    else if (failed && !ok) toast.error(`Rating failed — ${summary}`);
    else if (failed) toast.warning(summary);
    else toast.success(summary);
    refreshMatches();
  };
  const cancelBulkEval = () => { bulkCancelRef.current = true; };

  // NOTE the functional setState: reading `selectedId` directly would put it in the dep array, so
  // this identity would change on every selection — defeating the row memo again, just less often.
  const hideMatch = useCallback(async (match: Match) => {
    removeMatch(match.id, 1);
    setSelectedId((prev) => (prev === match.id ? null : prev));
    toast(`Removed "${match.title}" from dashboard`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          await fetch(`/api/jobs/${match.id}/hide`, { method: 'DELETE' });
          refreshMatches();
          revalidateDashboardStats();
          revalidateMatches();
          toast.success('Restored');
        },
      },
    });
    try {
      const res = await fetch(`/api/jobs/${match.id}/hide`, { method: 'POST' });
      if (!res.ok) throw new Error('hide failed');
      revalidateDashboardStats();
      revalidateMatches();
    } catch {
      toast.error('Failed to hide; refreshing');
      refreshMatches();
    }
  }, [removeMatch, refreshMatches]);
  const unhideMatch = async (match: Match) => {
    updateMatchHidden(match.id, false);
    try { await fetch(`/api/jobs/${match.id}/hide`, { method: 'DELETE' }); toast.success('Restored'); }
    catch { toast.error('Failed to restore'); refreshMatches(); }
  };

  // Memoised: these are O(n) over every loaded match and were recomputed on EVERY render — which,
  // with the search box being raw state, meant twice per keystroke. A third pass
  // (`indiaCompatibleCount`) was computed here and never read by anything; it has been removed.
  const topScore = useMemo(
    () => (matches.length ? Math.max(...matches.map((m) => m.finalScore)) : 0),
    [matches],
  );
  // "In focus" = the resume-derived domain boost fired (≥3 of your focus terms in the job).
  const domainCount = useMemo(() => matches.filter((m) => m.ontologyBoost > 0).length, [matches]);
  // Fresh jobs in the current matching feed (ingested or posted in last 48h)
  const freshMatchesCount = useMemo(() => {
    const now = Date.now();
    return matches.filter((m) => {
      const t = new Date(m.postedAt || m.ingestedAt || 0).getTime();
      return (now - t) < 48 * 3600 * 1000;
    }).length;
  }, [matches]);
  // Applied jobs are excluded by the matcher (server-side), so they are no longer present in
  // `matches` to count. The number comes from the applications table instead (as a COUNT, not the
  // rows), and the control is a link to /tracker — already a full Kanban — rather than a filter.

  const badgeFilterOptions: Array<{ value: LocationBadge | 'all'; label: string }> = [
    { value: 'all', label: 'All' }, { value: 'india', label: 'India' }, { value: 'remote-global', label: 'Remote · Global' },
    { value: 'visa', label: 'Visa' }, { value: 'relocation', label: 'Relocation' }, { value: 'remote-neutral', label: 'Remote' },
    { value: 'us-city', label: 'US city' }, { value: 'us-only', label: 'US only' },
  ];
  const archetypeOptions: Array<{ value: RoleArchetype | 'all'; label: string }> = [
    { value: 'all', label: 'All roles' }, { value: 'Architect', label: 'Architect' }, { value: 'Lead', label: 'Lead' },
    { value: 'Engineer', label: 'Engineer' }, { value: 'Solutions', label: 'Solutions' }, { value: 'Data', label: 'Data' },
    { value: 'DevOps', label: 'DevOps' }, { value: 'Product', label: 'Product' }, { value: 'Other', label: 'Other' },
  ];
  const archetypeCounts = useMemo(() => {
    const c: Partial<Record<RoleArchetype | 'all', number>> = { all: facets?.all ?? matches.length };
    if (facets?.archetype) for (const [k, n] of Object.entries(facets.archetype)) c[k as RoleArchetype] = n;
    else for (const m of matches) c[m.archetype] = (c[m.archetype] || 0) + 1;
    return c;
  }, [facets, matches]);

  const platformOptions: Array<{ value: string; label: string }> = [
    { value: 'all', label: 'All platforms' },
    { value: 'linkedin', label: 'LinkedIn' },
    { value: 'naukri', label: 'Naukri' },
    { value: 'direct', label: 'Direct ATS' },
  ];
  const platformCounts = useMemo(() => {
    const c: Record<string, number> = { all: facets?.all ?? matches.length };
    if (facets?.platform) {
      for (const [k, n] of Object.entries(facets.platform)) c[k] = n;
    } else {
      for (const m of matches) {
        const p = (m.sourcePlatform || m.source || '').toLowerCase();
        const u = (m.url || '').toLowerCase();
        let key = 'direct';
        if (p === 'linkedin' || u.includes('linkedin.com')) key = 'linkedin';
        else if (p === 'naukri' || u.includes('naukri.com')) key = 'naukri';
        c[key] = (c[key] || 0) + 1;
      }
    }
    return c;
  }, [facets, matches]);

  if (noResume) {
    return (
      <div className="mx-auto max-w-lg pt-12">
        <OnboardingBanner hasResume={false} jobCount={totalEmbedded} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-4.5rem)]">
      {/* First-run: resume exists but no jobs yet → guide them to run a Full sync. */}
      {totalEmbedded === 0 && <OnboardingBanner hasResume jobCount={0} />}
      {/* Info strip — one compact row */}
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniStat label="Matches" value={matches.length} hint={`of ${totalEmbedded.toLocaleString()} scanned`} icon={Target} />
        <MiniStat label="Top fit score" value={`${Math.min(100, Math.round(topScore * 100))}`} icon={TrendingUp} />
        <MiniStat label="In focus" value={domainCount} hint="resume match" icon={Sparkles} />
        <MiniStat label="New today" value={freshMatchesCount} hint="in feed" icon={CheckCircle2} />
      </div>

      {/* Filter toolbar — full width, separate from the job list */}
      <div className="shrink-0 space-y-2 rounded-xl border bg-card p-3 shadow-soft">
        <div className="flex flex-wrap items-center gap-2">
          {/* Dedicated Apply Mode Switcher */}
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setApplyMode('manual');
                setAutoApplyRunning(false);
              }}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-all',
                applyMode === 'manual'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Manual Apply
            </button>
            <button
              type="button"
              onClick={() => setApplyMode('auto')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all',
                applyMode === 'auto'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Sparkles className="h-3 w-3" />
              Auto Apply
            </button>
          </div>

          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input ref={searchInputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, company, location  (/)" className="h-9 pl-8" />
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="h-9 rounded-md border border-input bg-card text-foreground px-2.5 py-1 text-sm font-medium shadow-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
          >
            <option value="score" className="bg-card text-foreground py-1">Sort: Best match</option>
            <option value="eval" className="bg-card text-foreground py-1">Sort: Evaluation</option>
            <option value="recent" className="bg-card text-foreground py-1">Sort: Most recent</option>
            <option value="company" className="bg-card text-foreground py-1">Sort: Company</option>
            <option value="location" className="bg-card text-foreground py-1">Sort: Location</option>
          </select>
          {locationOptions.length > 1 && (
            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="h-9 max-w-[170px] rounded-md border border-input bg-card text-foreground px-2.5 py-1 text-sm font-medium shadow-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
              title="Filter by place"
            >
              <option value="all" className="bg-card text-foreground py-1">Place: All</option>
              {locationOptions.map(([label, n]) => (
                <option key={label} value={label} className="bg-card text-foreground py-1">{label} ({n})</option>
              ))}
            </select>
          )}
          {bulkEvalProgress ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] tabular text-muted-foreground">{bulkEvalProgress.current}/{bulkEvalProgress.total}</span>
              <Button variant="outline" size="sm" className="h-9" onClick={cancelBulkEval}>Stop</Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="h-9" onClick={() => bulkEvaluate(30)} disabled={filteredUnevaluatedCount === 0} title="Rate unevaluated jobs in view">
              <Wand2 className="h-3.5 w-3.5" />Rate
            </Button>
          )}
          <Button variant="outline" size="icon" className="h-9 w-9" onClick={handleRefresh} title="Refresh matches" disabled={refreshing}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          {hiddenCount > 0 && (
            <Button variant="ghost" size="sm" className="h-9 text-xs text-muted-foreground" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}{showHidden ? 'Hide hidden' : `Hidden (${hiddenCount})`}
            </Button>
          )}
          {appliedCount > 0 && (
            <Button asChild variant="ghost" size="sm" className="h-9 text-xs text-muted-foreground">
              <Link href="/tracker" title="Applied jobs live in the tracker — they are excluded from this list">
                <CheckCircle2 className="h-3.5 w-3.5" />Applied ({appliedCount})
              </Link>
            </Button>
          )}
          {anyFilterActive && (
            <>
              <Button variant="ghost" size="sm" className="h-9 px-2 text-xs" onClick={clearAllFilters}><X className="h-3 w-3" />Clear</Button>
              <Button variant="ghost" size="sm" className="h-9 px-2 text-xs" onClick={() => setShowSaveDialog((v) => !v)}><BookmarkPlus className="h-3 w-3" />Save</Button>
            </>
          )}
        </div>

        {/* Dedicated Auto-Apply Runner Controls (visible when Auto Apply mode is active) */}
        {applyMode === 'auto' && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0">
                {autoApplyRunning ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <Wand2 className="h-4 w-4" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold tracking-tight text-foreground truncate">
                    {autoApplyProgress
                      ? `Job [${autoApplyProgress.current}/${autoApplyProgress.total}] · ${autoApplyProgress.company} — ${autoApplyProgress.title}`
                      : `Auto-Apply Queue (${filtered.length} matched jobs)`}
                  </span>
                  <Badge variant={autoApplyRunning ? (autoApplyPaused ? 'warning' : 'success') : 'muted'} className="text-[10px] px-1.5 py-0 shrink-0">
                    {autoApplyRunning ? (autoApplyPaused ? 'Paused' : 'Running') : 'Ready'}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground truncate font-medium mt-0.5">
                  {autoApplyProgress?.stepText || autoApplyStatusMessage || (autoApplyRunning ? 'Processing application...' : 'Click Start to run auto-apply queue')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {!autoApplyRunning ? (
                <Button size="sm" onClick={startAutoApply} className="h-8 gap-1.5 text-xs">
                  <Play className="h-3.5 w-3.5 fill-current" />
                  Start Auto-Apply
                </Button>
              ) : (
                <>
                  {autoApplyPaused ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={resumeAutoApply}
                      className="h-8 gap-1.5 text-xs"
                      title="Resume auto-apply queue"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                      Resume
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={pauseAutoApply}
                      className="h-8 gap-1.5 text-xs"
                      title="Pause auto-apply queue"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      Pause
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handlePrevAutoApply}
                    disabled={currentFilteredIndex <= 0}
                    className="h-8 px-2 text-xs"
                    title="Previous job"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Prev
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleNextAutoApply}
                    disabled={currentFilteredIndex >= filtered.length - 1}
                    className="h-8 px-2.5 text-xs"
                    title="Next job in queue"
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={stopAutoApply}
                    className="h-8 px-2.5 text-xs"
                    title="Stop Auto Apply runner"
                  >
                    <Square className="h-3 w-3 fill-current" />
                    Stop
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
        {/* chip filter groups */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Fit</span>
            {(['all', 'apply', 'consider', 'skip', 'unevaluated'] as const).map((k) => (
              <button key={k} onClick={() => setEvalFilter(k)} className={cn('rounded-full border px-2 py-0.5 text-[11px] capitalize', evalFilter === k ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                {k === 'all' ? 'All' : k} <span className="tabular opacity-60">{evalCounts[k]}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Location</span>
            {badgeFilterOptions.map((o) => (
              <button key={o.value} onClick={() => setBadgeFilter(o.value)} className={cn('rounded-full border px-2 py-0.5 text-[11px]', badgeFilter === o.value ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>{o.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Platform</span>
            {platformOptions.map((o) => {
              const n = platformCounts[o.value] ?? 0;
              return (
                <button
                  key={o.value}
                  onClick={() => setPlatformFilter(o.value)}
                  disabled={o.value !== 'all' && n === 0}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] disabled:opacity-40',
                    platformFilter === o.value
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {o.label}
                  {o.value !== 'all' && <span className="tabular opacity-60"> {n}</span>}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Role</span>
            {archetypeOptions.map((o) => {
              const n = archetypeCounts[o.value] ?? 0;
              return (
                <button key={o.value} onClick={() => setArchetypeFilter(o.value)} disabled={o.value !== 'all' && n === 0} className={cn('rounded-full border px-2 py-0.5 text-[11px] disabled:opacity-40', archetypeFilter === o.value ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>{o.label}{o.value !== 'all' && <span className="tabular opacity-60"> {n}</span>}</button>
              );
            })}
          </div>
        </div>
        {showSaveDialog && (
          <div className="flex items-center gap-1">
            <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveCurrentSearch()} placeholder="Name this search" className="h-8 max-w-xs text-xs" />
            <Button size="sm" className="h-8" onClick={saveCurrentSearch}>Save</Button>
          </div>
        )}
        {savedSearches.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Saved</span>
            {savedSearches.map((s) => (
              <span key={s.name} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2 pr-1 text-[11px]">
                <button onClick={() => applySaved(s)} className="inline-flex items-center gap-1 hover:text-foreground"><Bookmark className="h-3 w-3" />{s.name}</button>
                <button onClick={() => removeSaved(s.name)} className="text-muted-foreground hover:text-destructive"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Two-pane: job list (left) + detail (right) */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* Left: list only */}
        <div className="flex w-full flex-col overflow-hidden rounded-xl border bg-card shadow-soft lg:w-[380px] lg:shrink-0">
          {/* List */}
          <div className="flex-1 overflow-y-auto scroll-slim">
            {isLoading && matches.length === 0 ? (
              <div className="space-y-2 p-3">{Array.from({ length: 6 }).map((_, i) => <RowSkeleton key={i} />)}</div>
            ) : error ? (
              <div className="p-6 text-center text-sm text-destructive">{String(error)}</div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-10 text-center">
                <Building2 className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">{anyFilterActive ? 'No matches for these filters' : 'No matches yet'}</p>
                <p className="text-xs text-muted-foreground">{anyFilterActive ? 'Try clearing filters.' : 'Run a sync to pull jobs.'}</p>
              </div>
            ) : (
              <div className="divide-y">
                {filtered.map((m, i) => (
                  <MatchRow
                    key={m.id}
                    m={m}
                    index={i}
                    selected={selectedId === m.id}
                    focused={focusedIdx === i}
                    onSelect={handleRowSelect}
                    onHide={hideMatch}
                    onPrefetch={prefetchJob}
                  />
                ))}
                {hasMore && (
                  <div className="p-3">
                    <Button variant="outline" size="sm" className="w-full" onClick={loadMore} disabled={loadingMore}>
                      {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Load more
                    </Button>
                  </div>
                )}
                {/* Honest counts. This used to read "Showing 30 of 10,720 embedded", implying the
                    filters had searched the whole corpus when they had only seen 30 rows. */}
                <p className="p-3 text-center text-[11px] text-muted-foreground">
                  Showing {filtered.length} of {totalFiltered.toLocaleString()} matching
                  {totalEmbedded > 0 && <> · {totalEmbedded.toLocaleString()} jobs indexed</>}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right: detail — plain scroll surface; the panel renders its own cards */}
        <div className="hidden min-w-0 flex-1 overflow-y-auto scroll-slim pr-1 lg:block">
          {selectedId != null ? (
            <JobDetailPanel
              jobId={selectedId}
              variant="pane"
              autoOpenApply={false}
              onAutoApplyNext={handleNextAutoApply}
              onHide={(id) => {
                const match = matches.find((m) => m.id === id);
                if (match) {
                  hideMatch(match);
                } else {
                  removeMatch(id, 1);
                  setSelectedId(null);
                  fetch(`/api/jobs/${id}/hide`, { method: 'POST' });
                  refreshMatches();
                  revalidateDashboardStats();
                  revalidateMatches();
                }
              }}
              onApplied={(id) => {
                removeMatch(id, 0);
                setSelectedId((prev) => (prev === id ? null : prev));
                refreshMatches();
                revalidateDashboardStats();
                revalidateMatches();
                revalidateApplications();
              }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 rounded-xl border bg-card text-center text-muted-foreground shadow-soft">
              <Target className="h-8 w-8" />
              <p className="text-sm">Select a job to see the full match, evaluation, and apply options.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, hint, icon: Icon }: { label: string; value: string | number; hint?: string; icon: typeof Target }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2 shadow-soft">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-none tabular">{value}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {label}{hint ? ` · ${hint}` : ''}
        </p>
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-lg p-2">
      <Skeleton className="h-9 w-9 rounded-lg" />
      <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-3 w-28" /></div>
      <Skeleton className="h-6 w-10 rounded-full" />
    </div>
  );
}

const MatchRow = memo(function MatchRow({
  m, index, selected, focused, onSelect, onHide, onPrefetch,
}: {
  m: Match; index: number; selected: boolean; focused: boolean;
  onSelect: (m: Match, i: number) => void;
  onHide: (m: Match) => void;
  onPrefetch: (id: number) => void;
}) {
  const onClick = () => onSelect(m, index);
  const badge = BADGE_CONFIG[m.locationBadge as LocationBadge];
  const EvalIcon = m.evaluation ? EVAL_ICON[m.evaluation.recommendation] : null;
  return (
    <div
      id={`match-row-${m.id}`}
      onClick={onClick}
      onMouseEnter={() => onPrefetch(m.id)}
      onFocus={() => onPrefetch(m.id)}
      className={cn(
        // `match-row` enables content-visibility (see globals.css) so offscreen rows cost no
        // layout/paint while staying in the DOM for keyboard nav and scrollIntoView.
        'match-row group flex cursor-pointer items-start gap-3 border-l-2 px-3 py-2.5 transition-colors',
        // Applied jobs get a persistent tint + green left-rail so they read as "done" even when
        // kept in the list (badge alone is easy to miss). Selected state still wins.
        selected ? 'border-l-transparent bg-accent'
          : m.applied ? 'border-l-success/50 bg-success/[0.06] hover:bg-success/10'
          : 'border-l-transparent hover:bg-accent/50',
        focused && !selected && 'ring-1 ring-inset ring-ring/40'
      )}
    >
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs font-semibold text-muted-foreground">
        {companyInitials(m.company)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-medium leading-tight">{m.title}</p>
          <div className="flex shrink-0 items-center gap-1">
            {(() => {
              const platform = resolvePlatformBadge(m);
              return platform ? (
                <Badge variant={platform.variant} className="text-[10px] font-normal">
                  {platform.label}
                </Badge>
              ) : null;
            })()}
            <ScoreBadge score={m.finalScore} size="sm" />
          </div>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{m.company}{m.location ? ` · ${m.location}` : ''}</p>

        {/* Line 1: Job posted time and apply type on the same line */}
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
            <Clock className="h-3 w-3 text-muted-foreground/70" />
            {formatJobAge(m.postedAt, m.ingestedAt, m.ageDays)}
          </span>
          <span className="text-muted-foreground/30">•</span>
          {m.applyType && (
            <Badge variant={APPLY_TYPE_BADGE[m.applyType].variant} className="text-[10px] font-normal h-4 py-0 px-1.5">
              {APPLY_TYPE_BADGE[m.applyType].label}
            </Badge>
          )}
          {m.applied && (
            <Badge variant={(APPLIED_BADGE[m.applicationStatus ?? 'applied'] ?? APPLIED_BADGE.applied).variant} className="gap-1 text-[10px] h-4 py-0 px-1.5">
              <CheckCircle2 className="h-2.5 w-2.5" />{(APPLIED_BADGE[m.applicationStatus ?? 'applied'] ?? APPLIED_BADGE.applied).label}
            </Badge>
          )}
        </div>

        {/* Line 2: Skill matches and reason badges on the next line */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {/* WHY this scored what it did — matched skills, missing must-haves, location, domain */}
          {(m.reasons || [])
            .filter((r) => r.kind !== 'freshness')
            .map((r, i) => (
              <Badge
                key={`${r.kind}-${i}`}
                variant={r.tone === 'good' ? 'success' : r.tone === 'bad' ? 'destructive' : 'muted'}
                className="text-[10px] font-normal"
              >
                {r.label}
              </Badge>
            ))}
          {/* Fallback for matched skills if reasons empty */}
          {!m.reasons?.length && m.skillFit?.matched?.slice(0, 3).map((s) => (
            <Badge key={s} variant="success" className="text-[10px] font-normal">
              {s} ✓
            </Badge>
          ))}
          {/* Fallback for a cached payload written before reasons existed. */}
          {!m.reasons?.length && badge && (
            <Badge variant={badge.variant} className="gap-1 text-[10px]"><badge.icon className="h-2.5 w-2.5" />{badge.label}</Badge>
          )}
          {!m.reasons?.length && EvalIcon && m.evaluation && (
            <Badge variant={m.evaluation.recommendation === 'apply' ? 'success' : m.evaluation.recommendation === 'skip' ? 'destructive' : 'warning'} className="gap-1 text-[10px] capitalize">
              <EvalIcon className="h-2.5 w-2.5" />{m.evaluation.recommendation}
            </Badge>
          )}
          {(m.legitimacy === 'caution' || m.legitimacy === 'suspicious') && (
            <Badge variant={m.legitimacy === 'suspicious' ? 'destructive' : 'warning'} className="gap-1 text-[10px] capitalize"><AlertTriangle className="h-2.5 w-2.5" />{m.legitimacy}</Badge>
          )}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onHide(m); }}
        className="mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-destructive group-hover:opacity-100"
        title="Hide (x)"
      >
        <EyeOff className="h-3.5 w-3.5" />
      </button>
    </div>
  );
});
