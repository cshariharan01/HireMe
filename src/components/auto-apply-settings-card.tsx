'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface ApplyConfig {
  portals: { greenhouse: boolean; ashby: boolean; linkedin: boolean; naukri: boolean; browser: boolean };
  rateLimit: { perDay: number; perHour: number };
  dryRun: boolean;
  resumeSource: 'original' | 'tailored';
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const PORTALS: Array<{
  key: keyof ApplyConfig['portals'];
  label: string;
  help: string;
  hidden?: boolean;
}> = [
  {
    key: 'greenhouse',
    label: 'Greenhouse',
    help: 'Submits directly through the public job-board API.',
  },
  {
    key: 'linkedin',
    label: 'LinkedIn Easy Apply',
    help: 'Opens LinkedIn Easy Apply in a visible browser, fills fields & attaches your tailored resume — you review and click Submit.',
  },
  {
    key: 'naukri',
    label: 'Naukri',
    help: 'Answers the Naukri chatbot questions it has prepared answers for and attaches your tailored resume — you review and click Submit.',
  },
  {
    key: 'browser',
    label: 'Open & autofill',
    help: 'Opens the real form in a visible browser, fills what it can — you review and click Submit.',
  },
  { key: 'ashby', label: 'Ashby', help: '', hidden: true },
];

export function AutoApplySettingsCard() {
  const { data, isLoading, mutate } = useSWR<{ config: ApplyConfig }>('/api/apply/config', fetcher);
  const [saving, setSaving] = useState(false);
  const config = data?.config;

  const patch = async (next: Partial<ApplyConfig>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/apply/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      toast.success('Auto-apply settings saved');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Wand2 className="h-4 w-4" /> Auto-apply
        </CardTitle>
        <CardDescription>
          What the assistant is allowed to do, and how often. Nothing is ever submitted without you
          opening the apply dialog for that specific job.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {config && (
          <>
            <div className="space-y-2">
              {PORTALS.filter((p) => !p.hidden).map((p) => (
                <label
                  key={p.key}
                  className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border p-3"
                >
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{p.label}</span>
                    <span className="block text-xs text-muted-foreground">{p.help}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    checked={config.portals[p.key]}
                    disabled={saving}
                    onChange={(e) =>
                      patch({ portals: { ...config.portals, [p.key]: e.target.checked } })
                    }
                  />
                </label>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">
                  Max applications per day
                </span>
                <Input
                  type="number"
                  min={1}
                  defaultValue={config.rateLimit.perDay}
                  disabled={saving}
                  onBlur={(e) => {
                    const perDay = parseInt(e.target.value, 10);
                    if (Number.isFinite(perDay) && perDay !== config.rateLimit.perDay) {
                      patch({ rateLimit: { ...config.rateLimit, perDay } });
                    }
                  }}
                />
              </label>
              <label className="space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">
                  Max per hour
                </span>
                <Input
                  type="number"
                  min={1}
                  defaultValue={config.rateLimit.perHour}
                  disabled={saving}
                  onBlur={(e) => {
                    const perHour = parseInt(e.target.value, 10);
                    if (Number.isFinite(perHour) && perHour !== config.rateLimit.perHour) {
                      patch({ rateLimit: { ...config.rateLimit, perHour } });
                    }
                  }}
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Resume to attach:</span>
              {(['original', 'tailored'] as const).map((src) => (
                <Button
                  key={src}
                  size="sm"
                  variant={config.resumeSource === src ? 'default' : 'outline'}
                  disabled={saving}
                  onClick={() => patch({ resumeSource: src })}
                >
                  {src === 'original' ? 'Your uploaded PDF' : 'AI-tailored (LaTeX Template)'}
                </Button>
              ))}
            </div>

            <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
              <span className="space-y-0.5">
                <span className="flex items-center gap-2 text-sm font-medium">
                  Dry-run mode
                  {config.dryRun && (
                    <Badge variant="warning" className="text-[10px]">
                      on
                    </Badge>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Build and preview the submission but never actually send it. Useful for checking
                  what would be submitted.
                </span>
              </span>
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-primary"
                checked={config.dryRun}
                disabled={saving}
                onChange={(e) => patch({ dryRun: e.target.checked })}
              />
            </label>
          </>
        )}
      </CardContent>
    </Card>
  );
}
