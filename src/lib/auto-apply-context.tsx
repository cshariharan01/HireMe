'use client';

import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import {
  type Match,
  revalidateApplications,
  revalidateMatches,
  revalidateDashboardStats,
  revalidateDigest,
} from '@/lib/hooks';

export interface AutoApplyProgress {
  current: number;
  total: number;
  company: string;
  title: string;
  stepText: string;
}

export type ApplyMode = 'manual' | 'auto';

interface AutoApplyContextType {
  applyMode: ApplyMode;
  setApplyMode: (mode: ApplyMode) => void;
  autoApplyRunning: boolean;
  autoApplyPaused: boolean;
  autoApplyProgress: AutoApplyProgress | null;
  autoApplyStatusMessage: string;
  activeJobId: number | null;
  startAutoApply: (queue: Match[], startIdx?: number) => Promise<void>;
  stopAutoApply: () => void;
  pauseAutoApply: () => void;
  resumeAutoApply: () => void;
}

const AutoApplyContext = createContext<AutoApplyContextType | null>(null);

export function AutoApplyProvider({ children }: { children: React.ReactNode }) {
  const [applyMode, setApplyModeState] = useState<ApplyMode>('manual');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('hs_apply_mode');
      if (saved === 'auto' || saved === 'manual') {
        setApplyModeState(saved);
      }
    }
  }, []);

  const setApplyMode = useCallback((mode: ApplyMode) => {
    setApplyModeState(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('hs_apply_mode', mode);
    }
  }, []);

  const [autoApplyRunning, setAutoApplyRunning] = useState(false);
  const [autoApplyPaused, setAutoApplyPaused] = useState(false);
  const [autoApplyProgress, setAutoApplyProgress] = useState<AutoApplyProgress | null>(null);
  const [autoApplyStatusMessage, setAutoApplyStatusMessage] = useState<string>('');
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const autoApplyStopRef = useRef(false);
  const autoApplyPausedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (autoApplyRunning) {
      setApplyMode('auto');
    }
  }, [autoApplyRunning, setApplyMode]);

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
    setActiveJobId(null);
    void fetch('/api/apply/focus-browser', { method: 'DELETE' }).catch(() => {});
    toast('Auto-Apply runner stopped.');
  }, []);

  const pauseAutoApply = useCallback(() => {
    autoApplyPausedRef.current = true;
    setAutoApplyPaused(true);
    setAutoApplyStatusMessage('Auto-Apply paused. Click Resume to continue.');
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    toast('Auto-Apply paused.');
  }, []);

  const resumeAutoApply = useCallback(() => {
    autoApplyPausedRef.current = false;
    setAutoApplyPaused(false);
    toast('Auto-Apply resumed.');
  }, []);

  const startAutoApply = useCallback(async (queue: Match[], startIdx = 0) => {
    if (!queue || queue.length === 0) {
      toast.error('No matched jobs in the current list to apply');
      return;
    }

    autoApplyStopRef.current = false;
    autoApplyPausedRef.current = false;
    setAutoApplyRunning(true);
    setAutoApplyPaused(false);

    const totalJobs = queue.length;
    const initialIdx = Math.max(0, Math.min(startIdx, queue.length - 1));
    void fetch('/api/apply/focus-browser', { method: 'PUT' }).catch(() => {});
    toast.success(`Starting Auto-Apply queue from job ${initialIdx + 1} of ${totalJobs}...`);

    for (let i = initialIdx; i < queue.length; i++) {
      if (autoApplyStopRef.current) break;

      while (autoApplyPausedRef.current) {
        if (autoApplyStopRef.current) break;
        setAutoApplyStatusMessage('Auto-Apply paused. Click Resume to continue.');
        await new Promise((r) => setTimeout(r, 400));
      }
      if (autoApplyStopRef.current) break;

      const job = queue[i];
      setActiveJobId(job.id);

      const STAGES = [
        'Submission preparation',
        'Tailoring résumé with AI',
        'Prework completed — launching Chrome window',
        'Navigating portal & pre-filling questions',
      ];

      const updateStageStatus = (stageIdx: number) => {
        if (autoApplyStopRef.current || autoApplyPausedRef.current) return;
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
        setTimeout(() => updateStageStatus(1), 1800),
        setTimeout(() => updateStageStatus(2), 4500),
        setTimeout(() => updateStageStatus(3), 8000),
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

        while (autoApplyPausedRef.current) {
          if (autoApplyStopRef.current) break;
          setAutoApplyStatusMessage('Auto-Apply paused. Click Resume to continue.');
          await new Promise((r) => setTimeout(r, 400));
        }
        if (autoApplyStopRef.current) break;

        const text = await res.text();
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          const cleanMsg = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          json = {
            ok: false,
            error: !res.ok
              ? `Server error (${res.status}): ${cleanMsg.slice(0, 150) || 'Internal error'}`
              : 'Server returned non-JSON response',
          };
        }

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

          for (let s = 0; s < 25; s++) {
            if (autoApplyStopRef.current) break;
            while (autoApplyPausedRef.current) {
              if (autoApplyStopRef.current) break;
              setAutoApplyStatusMessage('Auto-Apply paused. Click Resume to continue.');
              await new Promise((r) => setTimeout(r, 400));
            }
            if (autoApplyStopRef.current) break;
            await new Promise((r) => setTimeout(r, 100));
          }
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
          for (let s = 0; s < 50; s++) {
            if (autoApplyStopRef.current) break;
            while (autoApplyPausedRef.current) {
              if (autoApplyStopRef.current) break;
              setAutoApplyStatusMessage('Auto-Apply paused. Click Resume to continue.');
              await new Promise((r) => setTimeout(r, 400));
            }
            if (autoApplyStopRef.current) break;
            await new Promise((r) => setTimeout(r, 100));
          }
        } else {
          const isJobExpired = Boolean(
            json.expired ||
            json.response?.expired ||
            json.response?.platformStatus === 'expired' ||
            json.error?.toLowerCase().includes('expired')
          );
          const isCompanySite = Boolean(
            json.externalApply ||
            json.response?.externalApply ||
            json.response?.platformStatus === 'external_apply' ||
            json.error?.toLowerCase().includes('company website') ||
            json.error?.toLowerCase().includes('company site')
          );

          if (isJobExpired || isCompanySite) {
            revalidateMatches();
            revalidateDashboardStats();
          }

          let reason = json.error || 'Skipped (External site or closed posting)';
          if (isJobExpired) {
            reason = 'Job has expired (no longer accepting applications)';
          } else if (isCompanySite) {
            reason = 'Requires applying on company website (external)';
          }

          const msg = `${reason}. Switching to next job...`;
          toast.warning(`${job.company}: ${reason}`, { duration: 4000 });
          setAutoApplyStatusMessage(msg);
          setAutoApplyProgress({
            current: i + 1,
            total: totalJobs,
            company: job.company,
            title: job.title,
            stepText: msg,
          });
          const waitTicks = isJobExpired || isCompanySite ? 12 : 25;
          for (let s = 0; s < waitTicks; s++) {
            if (autoApplyStopRef.current) break;
            while (autoApplyPausedRef.current) {
              if (autoApplyStopRef.current) break;
              setAutoApplyStatusMessage('Auto-Apply paused. Click Resume to continue.');
              await new Promise((r) => setTimeout(r, 400));
            }
            if (autoApplyStopRef.current) break;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      } catch (err: any) {
        clearStageTimeouts();
        abortControllerRef.current = null;
        if (autoApplyStopRef.current) break;
        if (err?.name === 'AbortError' || autoApplyPausedRef.current) {
          while (autoApplyPausedRef.current) {
            if (autoApplyStopRef.current) break;
            setAutoApplyStatusMessage('Auto-Apply paused. Click Resume to continue.');
            await new Promise((r) => setTimeout(r, 400));
          }
          if (autoApplyStopRef.current) break;
          i--;
          continue;
        }
        const reason = err?.message || 'Application request failed';
        const msg = `Error: ${reason}. Switching to next job...`;
        toast.error(`${job.company}: ${reason}`, { duration: 4000 });
        setAutoApplyStatusMessage(msg);
        setAutoApplyProgress({
          current: i + 1,
          total: totalJobs,
          company: job.company,
          title: job.title,
          stepText: msg,
        });
        await new Promise((r) => setTimeout(r, 2500));
      }
    }

    setAutoApplyRunning(false);
    setAutoApplyPaused(false);
    setAutoApplyStatusMessage('');
    setAutoApplyProgress(null);
    setActiveJobId(null);
    void fetch('/api/apply/focus-browser', { method: 'DELETE' }).catch(() => {});
    revalidateApplications();
    revalidateMatches();
    revalidateDashboardStats();
    revalidateDigest();
    if (!autoApplyStopRef.current) {
      toast.success('Auto-Apply queue finished! All jobs processed.');
    }
  }, []);

  return (
    <AutoApplyContext.Provider
      value={{
        applyMode,
        setApplyMode,
        autoApplyRunning,
        autoApplyPaused,
        autoApplyProgress,
        autoApplyStatusMessage,
        activeJobId,
        startAutoApply,
        stopAutoApply,
        pauseAutoApply,
        resumeAutoApply,
      }}
    >
      {children}
    </AutoApplyContext.Provider>
  );
}

export function useAutoApply() {
  const ctx = useContext(AutoApplyContext);
  if (!ctx) {
    throw new Error('useAutoApply must be used within an AutoApplyProvider');
  }
  return ctx;
}
