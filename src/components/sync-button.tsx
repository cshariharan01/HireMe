'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { RefreshCw, Loader2, X, Square, Check, CheckCircle2, Circle, AlertTriangle, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { revalidateMatches, revalidateDigest } from '@/lib/hooks';

interface Step { script: string; label: string; status: string; }
interface SyncStatus {
  running: boolean;
  run: { mode: string; status: string; steps: Step[]; stepIndex: number; error: string | null; logTail: string[]; startedAt?: string } | null;
  lastSyncedAt: string | null;
  counts: { active: number; embedded: number; evaluated: number };
}

function LinkedinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
    </svg>
  );
}

function NaukriIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-4 13.5V8.5h2.5l3.5 5.5V8.5H16v7h-2.5L10 10v5.5H8z" />
    </svg>
  );
}

function fmtElapsed(sec: number): string {
  if (sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// SQLite stores UTC "YYYY-MM-DD HH:MM:SS"; parse as UTC and show a short relative time.
function relTime(s: string | null): string {
  if (!s) return 'never';
  const t = new Date(s.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(t)) return 'recently';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function SyncButton() {
  const { data, mutate } = useSWR<SyncStatus>('/api/sync', fetcher, { refreshInterval: (d) => (d?.running ? 1500 : 0) });
  const { data: applyModeData } = useSWR<{ mode: string; threshold: number }>('/api/profile/apply-mode', fetcher, { dedupingInterval: 30_000 });
  const applyMode = applyModeData?.mode ?? 'smart';
  const applyThreshold = applyModeData?.threshold ?? 60;
  const [menuOpen, setMenuOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const wasRunning = useRef(false);

  const running = !!data?.running;
  const run = data?.run;

  // Ticking elapsed timer while running (server sends startedAt as ISO).
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running || !run?.startedAt) return;
    const start = new Date(run.startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running, run?.startedAt]);

  // Detect run completion → toast + refresh matches.
  useEffect(() => {
    if (wasRunning.current && !running && run) {
      if (run.status === 'done') {
        toast.success('Sync complete — matches refreshed.');
        revalidateMatches();
        revalidateDigest();
      } else if (run.status === 'error') {
        toast.error(run.error || 'Sync failed. See details.');
      } else if (run.status === 'cancelled') {
        toast.message('Sync stopped. Ingested jobs saved.');
        revalidateMatches();
        revalidateDigest();
      }
    }
    wasRunning.current = running;
  }, [running, run]);

  const start = async (mode: 'linkedin' | 'naukri' | 'full' | 'quick' | 'rate') => {
    setMenuOpen(false);
    setStarting(true);
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (res.status === 409) toast.error('A sync is already running.');
      else if (!res.ok) toast.error('Could not start sync.');
      else {
        const msg =
          mode === 'linkedin'
            ? 'Syncing LinkedIn Easy Apply jobs…'
            : mode === 'naukri'
            ? 'Scanning Naukri Direct Apply jobs (Chrome scanner launching)…'
            : mode === 'full'
            ? 'Full sync started (LinkedIn + Naukri + Embedding)…'
            : mode === 'rate'
            ? 'Rating top matches…'
            : 'Quick sync started.';
        toast.message(msg);
      }
      await mutate();
    } catch {
      toast.error('Could not start sync.');
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    try { await fetch('/api/sync', { method: 'DELETE' }); await mutate(); } catch { /* ignore */ }
  };

  if (running && run) {
    const total = run.steps.length;
    const done = run.steps.filter((s) => s.status === 'done').length;
    const lastLog = [...(run.logTail || [])].reverse().find((l) => l && l.trim()) || 'Starting…';
    const sub = lastLog.match(/(\d+)\s*\/\s*(\d+)/);
    const pct = Math.round((done / Math.max(total, 1)) * 100);

    const modeBadge =
      run.mode === 'linkedin'
        ? { label: 'LinkedIn', color: 'bg-[#0A66C2]/15 text-[#0A66C2] dark:text-[#70B5F9] border-[#0A66C2]/30' }
        : run.mode === 'naukri'
        ? { label: 'Naukri', color: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30' }
        : run.mode === 'full'
        ? { label: 'Full Sync', color: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30' }
        : { label: run.mode, color: 'bg-muted text-muted-foreground border-border' };

    return (
      <>
        {/* Always-moving top bar */}
        <div className="fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden bg-info/20">
          <div className="animate-indeterminate h-full w-1/3 rounded-full bg-info" />
        </div>

        {/* Global floating active badge */}
        <div className="fixed top-3 right-4 z-50 hidden sm:flex items-center gap-2 rounded-full border bg-card/90 px-3 py-1.5 shadow-lg backdrop-blur-md">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-info" />
          <span className="text-xs font-semibold">Syncing {modeBadge.label}</span>
          <span className="text-[10px] font-mono tabular text-muted-foreground">({fmtElapsed(elapsed)})</span>
        </div>

        <div className="space-y-2.5 rounded-xl border bg-card p-3 shadow-soft">
          <div className="flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-info" />
            <span className="text-sm font-medium">Syncing</span>
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider border', modeBadge.color)}>
              {modeBadge.label}
            </span>
            <span className="ml-auto text-xs tabular text-muted-foreground">{fmtElapsed(elapsed)}</span>
          </div>

          {/* Step checklist */}
          <div className="space-y-1">
            {run.steps.map((s, i) => {
              const active = i === run.stepIndex;
              return (
                <div key={s.script} className="flex items-center gap-1.5 text-[11px] leading-tight">
                  {s.status === 'done' ? (
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
                  ) : s.status === 'error' ? (
                    <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
                  ) : active ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-info" />
                  ) : (
                    <Circle className="h-3 w-3 shrink-0 text-muted-foreground/40" />
                  )}
                  <span className={cn('truncate', active ? 'font-medium text-foreground' : s.status === 'done' ? 'text-muted-foreground' : 'text-muted-foreground/70')}>
                    {s.label}
                  </span>
                  {active && sub && <span className="ml-auto shrink-0 tabular text-[10px] text-muted-foreground">{sub[1]}/{sub[2]}</span>}
                </div>
              );
            })}
          </div>

          {/* Live log line */}
          <p className="truncate rounded-md bg-muted/60 px-2 py-1 font-mono text-[10px] text-muted-foreground" title={lastLog}>
            {lastLog.trim()}
          </p>

          {/* Step progress bar */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-info transition-all duration-500" style={{ width: `${Math.max(pct, 4)}%` }} />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[10px] tabular text-muted-foreground">
              {data?.counts ? `${data.counts.active.toLocaleString()} jobs` : ''} · step {run.stepIndex + 1}/{total}
            </span>
            <button onClick={cancel} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive transition-colors" title="Stop sync (jobs ingested so far remain saved)">
              <Square className="h-2.5 w-2.5 fill-current" /> Stop
            </button>
          </div>
        </div>
      </>
    );
  }

  const lastStatus = run?.status;
  const fresh = data?.lastSyncedAt && (Date.now() - new Date(data.lastSyncedAt.replace(' ', 'T') + 'Z').getTime()) < 24 * 3600 * 1000;

  return (
    <div className="relative rounded-xl border bg-card p-3 shadow-soft space-y-2.5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 rounded-full', fresh ? 'bg-success' : 'bg-warning')} />
          <span className="truncate">
            {lastStatus === 'error' ? 'Last sync failed' : `Synced ${relTime(data?.lastSyncedAt ?? null)}`}
          </span>
        </div>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          disabled={starting}
          aria-label="More sync options"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title="More options"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="text-[11px] tabular text-muted-foreground">
        {data ? `${data.counts.active.toLocaleString()} active · ${data.counts.evaluated} rated` : '…'}
      </div>

      {/* Apply Mode Badge */}
      <div className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide w-fit',
        applyMode === 'smart'
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-info/30 bg-info/10 text-info'
      )}>
        {applyMode === 'smart' ? `Smart ≥${applyThreshold}` : 'Apply All'}
      </div>

      {/* Platform Buttons */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => start('linkedin')}
          disabled={starting}
          title="Sync fresh LinkedIn Easy Apply jobs (silent & fast)"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#0A66C2]/30 bg-[#0A66C2]/10 px-2 py-2 text-xs font-semibold text-[#0A66C2] dark:text-[#70B5F9] hover:bg-[#0A66C2]/20 active:scale-[0.98] transition-all disabled:opacity-50"
        >
          <LinkedinIcon className="h-3.5 w-3.5 shrink-0" />
          <span>Sync LinkedIn</span>
        </button>

        <button
          onClick={() => start('naukri')}
          disabled={starting}
          title="Scan fresh Naukri Direct Apply jobs (launches Chrome scanner)"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-orange-500/30 bg-orange-500/10 px-2 py-2 text-xs font-semibold text-orange-600 dark:text-orange-400 hover:bg-orange-500/20 active:scale-[0.98] transition-all disabled:opacity-50"
        >
          <NaukriIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" />
          <span>Sync Naukri</span>
        </button>
      </div>

      {/* Full Sync Button */}
      <button
        onClick={() => start('full')}
        disabled={starting}
        title="Sync both LinkedIn and Naukri + generate embeddings"
        className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:opacity-95 active:scale-[0.98] transition-all disabled:opacity-50"
      >
        {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        <span>Full Sync</span>
      </button>

      {lastStatus === 'error' && (
        <p className="mt-1 flex items-start gap-1 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {run?.error || 'A step failed — see terminal/log.'}
        </p>
      )}

      {/* Dropdown menu for advanced options */}
      {menuOpen && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded-xl border bg-popover shadow-pop">
          <button onClick={() => start('linkedin')} className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-accent">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-[#0A66C2] dark:text-[#70B5F9]">
              <LinkedinIcon className="h-3.5 w-3.5" /> Sync LinkedIn Easy Apply
            </span>
            <span className="text-[10px] text-muted-foreground">Fast (~20s) · Headless HTTP · No popups</span>
          </button>
          <button onClick={() => start('naukri')} className="flex w-full flex-col items-start border-t px-3 py-2 text-left hover:bg-accent">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-orange-600 dark:text-orange-400">
              <NaukriIcon className="h-3.5 w-3.5" /> Sync Naukri Direct Apply
            </span>
            <span className="text-[10px] text-muted-foreground">Chrome scanner · Direct Apply only</span>
          </button>
          <button onClick={() => start('full')} className="flex w-full flex-col items-start border-t px-3 py-2 text-left hover:bg-accent">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
              <RefreshCw className="h-3.5 w-3.5" /> Full Sync (Both)
            </span>
            <span className="text-[10px] text-muted-foreground">LinkedIn + Naukri + Embedding</span>
          </button>
          <button onClick={() => start('quick')} className="flex w-full flex-col items-start border-t px-3 py-2 text-left hover:bg-accent">
            <span className="flex items-center gap-1.5 text-xs font-medium"><Check className="h-3.5 w-3.5" /> Quick index refresh</span>
            <span className="text-[10px] text-muted-foreground">Embed new + validate links · no scraping</span>
          </button>
          <button onClick={() => start('rate')} className="flex w-full flex-col items-start border-t px-3 py-2 text-left hover:bg-accent">
            <span className="flex items-center gap-1.5 text-xs font-medium"><CheckCircle2 className="h-3.5 w-3.5" /> Rate top matches</span>
            <span className="text-[10px] text-muted-foreground">AI-score top matches · LLM quota</span>
          </button>
        </div>
      )}
    </div>
  );
}
