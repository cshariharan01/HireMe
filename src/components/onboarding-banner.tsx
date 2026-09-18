'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Sparkles, FileUp, RefreshCw, CheckCircle2, Circle, X, BookOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// First-run guide. Shows the two required setup steps (upload resume + run a Full sync)
// and disappears once both are done. Rendered on the dashboard; `hasResume` and `jobCount`
// come from the matches hook, so it reflects real state with no extra fetch.
export function OnboardingBanner({ hasResume, jobCount }: { hasResume: boolean; jobCount: number }) {
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false);

  const step1Done = hasResume;
  const step2Done = jobCount > 0;
  if ((step1Done && step2Done) || dismissed) return null;

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
          <h2 className="text-sm font-semibold">Let&apos;s get you set up</h2>
          <p className="text-xs text-muted-foreground">Two quick steps and your matches will appear. Ollama must be running.</p>
        </div>
        {/* Dismiss only once the resume exists — before that, setup is required. */}
        {step1Done && (
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
        {/* Step 1 — resume */}
        <div className="flex items-center gap-2.5">
          <StepIcon done={step1Done} />
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm font-medium', step1Done && 'text-muted-foreground line-through')}>
              1. Upload your resume
            </p>
            <p className="text-[11px] text-muted-foreground">Parsed, embedded, and used to rank every job. You can keep several and switch.</p>
          </div>
          {!step1Done && (
            <Button asChild size="sm" className="shrink-0">
              <Link href="/profile"><FileUp className="mr-1.5 h-3.5 w-3.5" /> Upload</Link>
            </Button>
          )}
        </div>

        {/* Step 2 — full sync */}
        <div className="flex items-center gap-2.5">
          <StepIcon done={step2Done} />
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm font-medium', step2Done && 'text-muted-foreground line-through')}>
              2. Run a Full sync
            </p>
            <p className="text-[11px] text-muted-foreground">
              {step2Done
                ? `${jobCount.toLocaleString()} jobs in your pool.`
                : 'Pulls fresh jobs from all sources + company career pages. A few minutes.'}
            </p>
          </div>
          {!step2Done && (
            <Button onClick={startFullSync} disabled={starting} size="sm" variant="secondary" className="shrink-0">
              {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              Run Full sync
            </Button>
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
