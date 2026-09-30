'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Sparkles, FileUp, RefreshCw, CheckCircle2, Circle, X, BookOpen, Loader2, Key, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import useSWR from 'swr';
import { PlatformLoginCard } from '@/components/platform-login-card';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// First-run guide. Shows three required setup steps:
// 1. Configure an API key (LLM provider)
// 2. Upload resume
// 3. Run a Full sync
// Disappears once all are done.
export function OnboardingBanner({ hasResume, jobCount }: { hasResume: boolean; jobCount: number }) {
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);

  // Check if any LLM provider is configured
  const { data: providersData } = useSWR('/api/providers', fetcher, { dedupingInterval: 30_000 });
  const hasProvider = (providersData?.providers?.length ?? 0) > 0;

  const step1Done = hasProvider;
  const step2Done = hasResume;
  const step3Done = jobCount > 0;

  if ((step1Done && step2Done && step3Done) || dismissed) return null;

  const launchPlatformLogin = async (platform: 'naukri' | 'linkedin') => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      const data = await res.json();
      if (data.ok) toast.success(`Chrome launched for ${platform === 'naukri' ? 'Naukri' : 'LinkedIn'}! Sign in in Chrome.`);
      else toast.error(data.error || 'Could not launch login browser.');
    } catch {
      toast.error('Failed to launch Chrome browser.');
    }
  };

  const startFullSync = async () => {
    setStarting(true);
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      });
      if (res.status === 409) toast.error('A sync is already running.');
      else if (!res.ok) toast.error('Could not start sync.');
      else toast.success('Full sync started — watch progress in the sidebar. Takes a few minutes.');
    } catch {
      toast.error('Could not start sync.');
    } finally {
      setStarting(false);
    }
  };

  const StepIcon = ({ done }: { done: boolean }) =>
    done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" />;

  return (
    <div className="rounded-xl border bg-card p-4 shadow-soft">
      <div className="mb-3 flex items-start gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Welcome to HireMe — let&apos;s get you set up</h2>
          <p className="text-xs text-muted-foreground">Three quick steps and your personalised job matches will appear.</p>
        </div>
        {/* Dismiss only once API key + resume exist */}
        {step1Done && step2Done && (
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="space-y-2.5">
        {/* Step 1 — API key */}
        <div className="flex items-start gap-2.5">
          <StepIcon done={step1Done} />
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm font-medium', step1Done && 'text-muted-foreground line-through')}>
              1. Add your free Gemini API key
            </p>
            <p className="text-[11px] text-muted-foreground">
              Get a free key at{' '}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                aistudio.google.com <ExternalLink className="h-2.5 w-2.5" />
              </a>
              {' '}— no billing required, 1500 requests/day free.
            </p>
          </div>
          {!step1Done && (
            <Button asChild size="sm" className="shrink-0">
              <Link href="/settings">
                <Key className="mr-1.5 h-3.5 w-3.5" /> Add Key
              </Link>
            </Button>
          )}
        </div>

        {/* Step 2 — resume */}
        <div className="flex items-center gap-2.5">
          <StepIcon done={step2Done} />
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm font-medium', step2Done && 'text-muted-foreground line-through')}>
              2. Upload your resume
            </p>
            <p className="text-[11px] text-muted-foreground">Parsed by AI and embedded to rank every job against your profile.</p>
          </div>
          {!step2Done && (
            <Button asChild size="sm" className="shrink-0" disabled={!step1Done}>
              <Link href="/profile"><FileUp className="mr-1.5 h-3.5 w-3.5" /> Upload</Link>
            </Button>
          )}
        </div>

        {/* Step 3 — full sync & platform logins */}
        <div className="flex flex-wrap items-center gap-2.5">
          <StepIcon done={step3Done} />
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm font-medium', step3Done && 'text-muted-foreground line-through')}>
              3. Connect platforms &amp; run Full sync
            </p>
            <p className="text-[11px] text-muted-foreground">
              {step3Done
                ? `${jobCount.toLocaleString()} jobs in your pool.`
                : 'Sign into Naukri/LinkedIn in Chrome, then run Full Sync.'}
            </p>
          </div>
          {!step3Done && (
            <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => launchPlatformLogin('naukri')}
                className="border-orange-500/30 text-orange-600 dark:text-orange-400 hover:bg-orange-500/10 h-8 text-xs"
              >
                Sign in Naukri
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => launchPlatformLogin('linkedin')}
                className="border-[#0A66C2]/30 text-[#0A66C2] dark:text-[#70B5F9] hover:bg-[#0A66C2]/10 h-8 text-xs"
              >
                Sign in LinkedIn
              </Button>
              <Button onClick={startFullSync} disabled={starting || !step1Done || !step2Done} size="sm" variant="secondary" className="h-8 text-xs">
                {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                Run Full sync
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 border-t pt-2.5">
        <Link href="/guide" className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
          <BookOpen className="h-3.5 w-3.5" /> Read the full guide
        </Link>
      </div>
    </div>
  );
}

