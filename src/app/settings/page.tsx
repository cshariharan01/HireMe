'use client';

import { useEffect, useState, useCallback } from 'react';
import useSWR from 'swr';
import {
  Settings as SettingsIcon,
  Key,
  Loader2,
  Check,
  X,
  Plus,
  Trash2,
  Activity,
  Info,
  Database,
  Cpu,
  Zap,
  Gauge,
  Sparkles,
  Clock,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { AutoApplySettingsCard } from '@/components/auto-apply-settings-card';
import { ScreeningAnswersCard } from '@/components/screening-answers-card';
import { PlatformLoginCard } from '@/components/platform-login-card';

type ProviderKind = 'gemini' | 'openai' | 'anthropic' | 'openai-compatible' | 'freeway';

interface ModelSpec {
  id: string;
  name: string;
  contextWindow: string;
  hitsLimitDaily: number;
  rpmLimit: number;
  tpmLimit: number;
  isRecommended?: boolean;
}

interface LLMUsageStats {
  hitsToday: number;
  tokensToday: number;
  hitsRemaining: number;
  tokensRemaining: number;
  hitsUsagePercent: number;
  tokensUsagePercent: number;
  lastUsedAt: string | null;
}

interface ProviderRow {
  id: number;
  kind: ProviderKind;
  display_name: string;
  model: string;
  base_url: string | null;
  api_key_masked: string | null;
  is_active: boolean;
  is_creative: boolean;
  cooldown_until?: string | null;
  created_at: string;
  availableModels?: ModelSpec[];
  currentModelSpec?: ModelSpec;
  usage?: LLMUsageStats;
}

interface ProvidersResponse {
  providers: ProviderRow[];
  activePrimary: ProviderRow | null;
  activeCreative: ProviderRow | null;
}

interface EmbeddingsInfo {
  provider: string;
  model: string;
  signature: string;
  corpusSignature: string | null;
  consistent: boolean;
  embeddedJobs: number;
}

const KIND_OPTIONS: Array<{ value: ProviderKind; label: string; hint: string; needsKey: boolean; needsBaseUrl: boolean; keyOptional?: boolean }> = [
  { value: 'gemini', label: 'Google Gemini', hint: '✅ Free tier — 1,500 req/day, no billing. Get key at aistudio.google.com/apikey', needsKey: true, needsBaseUrl: false },
  { value: 'freeway', label: 'Freeway (NVIDIA Cloud)', hint: 'Generous free tier — recommended for quick setup. Free key from build.nvidia.com', needsKey: true, needsBaseUrl: false, keyOptional: true },
  { value: 'openai', label: 'OpenAI (GPT-4o, o3-mini)', hint: 'Requires paid OpenAI API key', needsKey: true, needsBaseUrl: false },
  { value: 'anthropic', label: 'Anthropic Claude', hint: 'Requires paid Anthropic API key', needsKey: true, needsBaseUrl: false },
  { value: 'openai-compatible', label: 'Groq / Cerebras / Mistral / Together', hint: 'Any provider with an OpenAI-compatible /v1/chat/completions endpoint', needsKey: true, needsBaseUrl: true },
];

const KIND_PRESETS = {
  groq: { display_name: 'Groq (Free 1k RPD)', kind: 'openai-compatible' as const, model: 'llama-3.3-70b-versatile', base_url: 'https://api.groq.com/openai/v1' },
  cerebras: { display_name: 'Cerebras (Ultra-fast)', kind: 'openai-compatible' as const, model: 'llama-3.3-70b', base_url: 'https://api.cerebras.ai/v1' },
  mistral: { display_name: 'Mistral AI', kind: 'openai-compatible' as const, model: 'mistral-small-latest', base_url: 'https://api.mistral.ai/v1' },
};

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export default function SettingsPage() {
  const { data, mutate } = useSWR<ProvidersResponse>('/api/providers', fetcher);
  const { data: embData } = useSWR<{ info: EmbeddingsInfo }>('/api/embeddings/info', fetcher);
  const embInfo = embData?.info;

  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState<{
    kind: ProviderKind;
    display_name: string;
    model: string;
    base_url: string;
    api_key: string;
  }>({
    kind: 'gemini',
    display_name: 'Google Gemini',
    model: 'gemini-3.8-flash',
    base_url: '',
    api_key: '',
  });

  const providers = data?.providers ?? [];

  const onKindChange = (kind: ProviderKind) => {
    const defaults: Record<ProviderKind, { display_name: string; model: string; base_url: string }> = {
      gemini: { display_name: 'Google Gemini', model: 'gemini-3.8-flash', base_url: '' },
      freeway: { display_name: 'Freeway (NVIDIA Cloud)', model: 'nvidia/nemotron-3-super-120b-a12b:free', base_url: '' },
      openai: { display_name: 'OpenAI', model: 'gpt-4o-mini', base_url: '' },
      anthropic: { display_name: 'Anthropic Claude', model: 'claude-3-5-haiku-20241022', base_url: '' },
      'openai-compatible': { display_name: 'Groq', model: 'llama-3.3-70b-versatile', base_url: 'https://api.groq.com/openai/v1' },
    };
    const d = defaults[kind];
    setForm({ kind, display_name: d.display_name, model: d.model, base_url: d.base_url, api_key: '' });
  };

  const applyPreset = (key: keyof typeof KIND_PRESETS) => {
    const p = KIND_PRESETS[key];
    setForm((f) => ({ ...f, kind: p.kind, display_name: p.display_name, model: p.model, base_url: p.base_url }));
  };

  const create = async () => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: form.kind,
          display_name: form.display_name,
          model: form.model,
          base_url: form.base_url || null,
          api_key: form.api_key || null,
        }),
      });
      const json = await res.json();
      if (json.error) toast.error(json.error);
      else {
        toast.success('Provider added');
        setAdding(false);
        mutate();
      }
    } catch {
      toast.error('Failed to save provider');
    } finally {
      setSubmitting(false);
    }
  };

  const changeModel = async (id: number, model: string) => {
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const json = await res.json();
      if (json.error) toast.error(json.error);
      else {
        toast.success(`Updated model to ${model}`);
        mutate();
      }
    } catch {
      toast.error('Failed to update model');
    }
  };

  const activate = async (id: number, currentlyActive: boolean) => {
    const url = currentlyActive ? `/api/providers/${id}/activate?clear=1` : `/api/providers/${id}/activate`;
    try {
      const res = await fetch(url, { method: 'POST' });
      const json = await res.json();
      if (json.error) toast.error(json.error);
      else {
        toast.success(currentlyActive ? 'Deactivated — falling back to env-based provider' : 'Activated');
        mutate();
      }
    } catch {
      toast.error('Failed to activate');
    }
  };

  const setCreative = async (id: number, currentlyCreative: boolean) => {
    try {
      const res = await fetch(`/api/providers/${id}/creative`, { method: currentlyCreative ? 'DELETE' : 'POST' });
      const json = await res.json();
      if (json.error) toast.error(json.error);
      else {
        toast.success(currentlyCreative ? 'Cleared creative flag — falling back to Gemini default' : 'Set as creative provider for cover-letter / resume-variant');
        mutate();
      }
    } catch {
      toast.error('Failed to update creative flag');
    }
  };

  const remove = async (id: number) => {
    try {
      await fetch(`/api/providers/${id}`, { method: 'DELETE' });
      toast.success('Deleted');
      mutate();
    } catch {
      toast.error('Failed to delete');
    }
  };

  const test = async (id: number) => {
    setTesting(id);
    try {
      const res = await fetch(`/api/providers/${id}/test`, { method: 'POST' });
      const json = await res.json();
      if (json.ok) toast.success(`OK: ${json.response || 'reachable'}`);
      else toast.error(`Failed: ${json.error}`);
    } catch (e) {
      toast.error(`Test failed: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setTesting(null);
    }
  };

  const activePrimary = data?.activePrimary;
  const activeCreative = data?.activeCreative;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-2">
          <SettingsIcon className="h-6 w-6" />
          Settings
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure LLM providers, active app models, API key usage statistics, and auto-apply controls.
        </p>
      </div>

      {/* Currently Using Summary Card */}
      <Card className="border-primary/20 bg-card/60 backdrop-blur-xs">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" />
            Currently Used Models by App
          </CardTitle>
          <CardDescription>
            Live status of models powering auto-apply matching, screening, and creative resume generation.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border p-3 bg-muted/20 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-500 flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                Primary App Model
              </span>
              <Badge variant="outline" className="text-[10px]">Auto-Apply & Matching</Badge>
            </div>
            {activePrimary ? (
              <div>
                <p className="font-semibold text-sm">{activePrimary.display_name}</p>
                <p className="text-xs font-mono text-muted-foreground">{activePrimary.model}</p>
              </div>
            ) : (
              <div>
                <p className="font-semibold text-sm">Default Environment Model</p>
                <p className="text-xs text-muted-foreground font-mono">gemini-3.8-flash (via GEMINI_API_KEY)</p>
              </div>
            )}
          </div>

          <div className="rounded-lg border p-3 bg-muted/20 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-purple-500 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5" />
                Creative App Model
              </span>
              <Badge variant="outline" className="text-[10px]">Cover Letter & Tailoring</Badge>
            </div>
            {activeCreative ? (
              <div>
                <p className="font-semibold text-sm">{activeCreative.display_name}</p>
                <p className="text-xs font-mono text-muted-foreground">{activeCreative.model}</p>
              </div>
            ) : (
              <div>
                <p className="font-semibold text-sm">Fallback Primary Model</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {activePrimary ? `${activePrimary.display_name} (${activePrimary.model})` : 'gemini-3.8-flash (Default)'}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start w-full min-w-0">
        {/* Left 2 Columns: Primary Configuration Cards */}
        <div className="space-y-6 lg:col-span-2 min-w-0 w-full">
          {/* 1. LLM Providers */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">LLM Providers & API Usage</CardTitle>
                  <CardDescription className="text-xs">
                    Configure API keys, select models, and monitor live API usage metrics.
                  </CardDescription>
                </div>
                <Button size="sm" onClick={() => setAdding((v) => !v)} variant={adding ? 'ghost' : 'default'}>
                  {adding ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {adding ? 'Cancel' : 'Add provider'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {!data ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading providers…
                </div>
              ) : providers.length === 0 && !adding && (
                <p className="text-sm text-muted-foreground py-4 text-center">No providers configured yet. Click &quot;Add provider&quot;.</p>
              )}
              {providers.map((p) => {
                const availableModels = p.availableModels || [];
                const usage = p.usage || {
                  hitsToday: 0,
                  tokensToday: 0,
                  hitsRemaining: 1500,
                  tokensRemaining: 1000000,
                  hitsUsagePercent: 0,
                  tokensUsagePercent: 0,
                  lastUsedAt: null,
                };
                const spec = p.currentModelSpec || {
                  id: p.model,
                  name: p.model,
                  contextWindow: '128K Tokens',
                  hitsLimitDaily: 1500,
                  rpmLimit: 30,
                  tpmLimit: 1000000,
                };

                return (
                  <div
                    key={p.id}
                    className={cn(
                      'rounded-lg border p-4 transition-colors space-y-3.5',
                      p.is_active && 'border-emerald-500/50 bg-emerald-500/5',
                      p.is_creative && !p.is_active && 'border-purple-500/50 bg-purple-500/5'
                    )}
                  >
                    {/* Header bar */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-base">{p.display_name}</span>
                          <Badge variant="outline" className="text-[10px] uppercase font-mono">{p.kind}</Badge>
                          {p.is_active && (
                            <Badge variant="success" className="text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                              <Activity className="h-2.5 w-2.5 mr-1 animate-pulse" />
                              Currently Used (Primary App Model)
                            </Badge>
                          )}
                          {p.is_creative && (
                            <Badge variant="info" className="text-[10px] bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30">
                              <Sparkles className="h-2.5 w-2.5 mr-1" />
                              Currently Used (Creative App Model)
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          {p.base_url && <span className="truncate font-mono">Base: {p.base_url}</span>}
                          {p.api_key_masked && (
                            <span className="flex items-center gap-1 font-mono">
                              <Key className="h-3 w-3 text-muted-foreground" />
                              API Key: {p.api_key_masked}
                            </span>
                          )}
                          {p.cooldown_until && (
                            <span className="text-amber-500 font-medium flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              Cooldown until {new Date(p.cooldown_until).toLocaleTimeString()}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                        <Button size="sm" variant="ghost" onClick={() => test(p.id)} disabled={testing === p.id} className="h-7 text-xs">
                          {testing === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Test'}
                        </Button>
                        <Button
                          size="sm"
                          variant={p.is_active ? 'outline' : 'default'}
                          onClick={() => activate(p.id, p.is_active)}
                          className="h-7 text-xs"
                        >
                          {p.is_active ? 'Deactivate' : 'Set as Primary'}
                        </Button>
                        <Button
                          size="sm"
                          variant={p.is_creative ? 'outline' : 'ghost'}
                          onClick={() => setCreative(p.id, p.is_creative)}
                          className="h-7 text-xs"
                          title="Use this provider for cover letter and creative generation"
                        >
                          {p.is_creative ? 'Clear Creative' : 'Set as Creative'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(p.id)} className="h-7 text-destructive hover:text-destructive hover:bg-destructive/10">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Model Switcher Dropdown */}
                    <div className="rounded-md border bg-muted/30 p-2.5 space-y-2">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Cpu className="h-3.5 w-3.5 text-primary" />
                          Selected LLM Model
                        </label>
                        <span className="text-[11px] text-muted-foreground">
                          Context Window: <strong className="text-foreground">{spec.contextWindow}</strong>
                        </span>
                      </div>
                      <div className="relative">
                        <select
                          value={p.model}
                          onChange={(e) => changeModel(p.id, e.target.value)}
                          className="flex h-9 w-full rounded-md border border-input bg-card text-foreground px-3 py-1.5 text-xs font-medium shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer appearance-none pr-8"
                        >
                          {availableModels.map((m) => (
                            <option key={m.id} value={m.id} className="bg-card text-foreground py-1">
                              {m.name} ({m.id}) {m.isRecommended ? '— Recommended' : ''}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
                      </div>
                    </div>

                    {/* API Key Usage Metrics: Hit, Tokens, Limit */}
                    <div className="grid gap-2.5 sm:grid-cols-3">
                      {/* Metric 1: Hit */}
                      <div className="rounded-md border bg-card p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-muted-foreground flex items-center gap-1">
                            <Zap className="h-3.5 w-3.5 text-amber-500" />
                            Hit (RPD)
                          </span>
                          <span className="font-mono text-[11px]">
                            {usage.hitsToday.toLocaleString()} / {spec.hitsLimitDaily.toLocaleString()}
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                          <div
                            className={cn(
                              'h-full transition-all duration-300',
                              usage.hitsUsagePercent > 90 ? 'bg-destructive' : usage.hitsUsagePercent > 70 ? 'bg-amber-500' : 'bg-emerald-500'
                            )}
                            style={{ width: `${Math.min(100, Math.max(5, usage.hitsUsagePercent))}%` }}
                          />
                        </div>
                        <div className="flex justify-between items-center text-[10px] text-muted-foreground">
                          <span>Usage Limit: {spec.hitsLimitDaily.toLocaleString()} Hits/day</span>
                          <span className="font-semibold text-foreground">{usage.hitsRemaining.toLocaleString()} Hits left</span>
                        </div>
                      </div>

                      {/* Metric 2: Tokens */}
                      <div className="rounded-md border bg-card p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-muted-foreground flex items-center gap-1">
                            <Gauge className="h-3.5 w-3.5 text-blue-500" />
                            Tokens (TPM)
                          </span>
                          <span className="font-mono text-[11px]">
                            {usage.tokensToday.toLocaleString()} / {spec.tpmLimit.toLocaleString()}
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                          <div
                            className={cn(
                              'h-full transition-all duration-300',
                              usage.tokensUsagePercent > 90 ? 'bg-destructive' : usage.tokensUsagePercent > 70 ? 'bg-amber-500' : 'bg-blue-500'
                            )}
                            style={{ width: `${Math.min(100, Math.max(5, usage.tokensUsagePercent))}%` }}
                          />
                        </div>
                        <div className="flex justify-between items-center text-[10px] text-muted-foreground">
                          <span>Limit: {spec.tpmLimit.toLocaleString()} TPM</span>
                          <span className="font-semibold text-foreground">{usage.tokensRemaining.toLocaleString()} Tokens left</span>
                        </div>
                      </div>

                      {/* Metric 3: Limit */}
                      <div className="rounded-md border bg-card p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-muted-foreground flex items-center gap-1">
                            <Activity className="h-3.5 w-3.5 text-purple-500" />
                            Limit (RPM)
                          </span>
                          <span className="font-mono font-semibold text-xs">{spec.rpmLimit} Hits/min</span>
                        </div>
                        <div className="text-[11px] space-y-0.5">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground text-[10px]">Status:</span>
                            <span className={cn('text-[10px] font-semibold', p.cooldown_until ? 'text-amber-500' : 'text-emerald-500')}>
                              {p.cooldown_until ? 'Rate-limited (Cooldown)' : 'Active (Ready)'}
                            </span>
                          </div>
                          <div className="flex justify-between text-[10px] text-muted-foreground">
                            <span>Last API Hit:</span>
                            <span>{usage.lastUsedAt ? new Date(usage.lastUsedAt).toLocaleTimeString() : 'Never today'}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {adding && (
                <>
                  <Separator className="my-2" />
                  <div className="space-y-3 rounded-md border-2 border-dashed border-border p-4 bg-muted/10">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">New provider configuration</p>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Kind</label>
                      <div className="relative">
                        <select
                          value={form.kind}
                          onChange={(e) => onKindChange(e.target.value as ProviderKind)}
                          className="flex h-9 w-full rounded-md border border-input bg-card text-foreground px-3 py-1 text-sm font-medium shadow-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer appearance-none pr-8"
                        >
                          {KIND_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value} className="bg-card text-foreground py-1">{o.label}</option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
                      </div>
                      <p className="text-xs text-muted-foreground">{KIND_OPTIONS.find((o) => o.value === form.kind)?.hint}</p>
                    </div>

                    {form.kind === 'openai-compatible' && (
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Quick presets</label>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(KIND_PRESETS).map(([key, p]) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => applyPreset(key as keyof typeof KIND_PRESETS)}
                              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                            >
                              {p.display_name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Display name</label>
                      <Input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="My provider" />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Model</label>
                      <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="model-id" />
                    </div>

                    {(KIND_OPTIONS.find((o) => o.value === form.kind)?.needsBaseUrl) && (
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Base URL</label>
                        <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://..." />
                      </div>
                    )}

                    {(KIND_OPTIONS.find((o) => o.value === form.kind)?.needsKey) && (
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                          <Key className="h-3 w-3" />
                          API key
                          {KIND_OPTIONS.find((o) => o.value === form.kind)?.keyOptional && (
                            <span className="normal-case tracking-normal font-normal">— optional, falls back to FREEWAY_API_KEY</span>
                          )}
                        </label>
                        <Input
                          type="password"
                          value={form.api_key}
                          onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                          placeholder="sk-..."
                          autoComplete="off"
                        />
                        <p className="text-[10px] text-muted-foreground">Stored in your local SQLite file at <code className="bg-muted px-1 rounded">data/hireme.db</code>. Never sent anywhere except to the provider you configured.</p>
                      </div>
                    )}

                    <Button onClick={create} disabled={submitting} size="sm">
                      {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Add Provider
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* 2. Embeddings Card */}
          {embInfo && (
            <Card className={cn(!embInfo.consistent && 'border-destructive/40 bg-destructive/5')}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2"><Database className="h-4 w-4" /> Embeddings</CardTitle>
                <CardDescription>
                  Powers job matching. Configured separately from chat, via <code className="text-xs bg-muted px-1 rounded">EMBEDDING_PROVIDER</code> in <code className="text-xs bg-muted px-1 rounded">.env.local</code>.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="uppercase text-[10px]">{embInfo.provider}</Badge>
                  <span className="font-mono text-xs text-muted-foreground">{embInfo.model}</span>
                  <span className="text-xs text-muted-foreground">· {embInfo.embeddedJobs.toLocaleString()} jobs embedded</span>
                </div>
                <p className="text-xs text-muted-foreground">Cloud embeddings via Gemini — fast and no local install required.</p>
                {!embInfo.consistent && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                    <strong>Provider changed.</strong> Your data was embedded with <code className="font-mono">{embInfo.corpusSignature}</code> but the app is now set to <code className="font-mono">{embInfo.signature}</code>. New embeddings are blocked to keep matches valid. Either set it back, or re-embed everything: <code className="font-mono">npm run db:reset</code> then re-add your résumé and run a full sync.
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* 3. Platform Logins (Naukri & LinkedIn) */}
          <PlatformLoginCard />

          {/* 4. Auto-apply Controls */}
          <AutoApplySettingsCard />

          {/* 5. Screening Answers Library */}
          <ScreeningAnswersCard />
        </div>

        {/* Right 1 Column: Help & Guidance */}
        <div className="space-y-6 lg:col-span-1 min-w-0 w-full">
          {!activePrimary && providers.length === 0 && (
            <Card className="border-info/30 bg-info/5">
              <CardContent className="p-4 flex items-start gap-3 text-sm">
                <Info className="h-4 w-4 mt-0.5 text-info shrink-0" />
                <div>
                  No providers configured. The app is using the default env-based provider (Google Gemini free tier).
                  Add a provider to use Groq (free 1k RPD), Cerebras, Mistral, OpenAI, or Anthropic.
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="bg-muted/20">
            <CardHeader>
              <CardTitle className="text-base font-medium">Provider & Model Selection Guide</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs text-emerald-600 dark:text-emerald-400">
                <strong>Recommended:</strong> Google Gemini free tier (Gemini 3.8 Flash) — 1,500 Hits/day, no credit card needed.
                {' '}<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="underline">Get free key →</a>
              </div>
              <ol className="list-decimal list-inside text-muted-foreground space-y-2.5 text-xs">
                <li><strong>Primary App Model:</strong> Used for core application tasks (matching, auto-apply screening). Marked with <span className="text-emerald-500 font-semibold">Currently Used (Primary App Model)</span>.</li>
                <li><strong>Creative App Model:</strong> Used for high-creativity tasks (cover letters and tailored résumé variants). Marked with <span className="text-purple-500 font-semibold">Currently Used (Creative App Model)</span>.</li>
                <li><strong>Model Selector:</strong> Switch available models for any provider directly from the dropdown to optimize speed or accuracy.</li>
                <li><strong>API Key Metrics:</strong> Live tracking of <strong>Hit</strong> (Requests per day), <strong>Tokens</strong> (Tokens per minute / daily total), and <strong>Limit</strong> (Requests per minute rate limit and cooldown status).</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

