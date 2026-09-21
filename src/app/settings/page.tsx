'use client';

import { useEffect, useState, useCallback } from 'react';
import useSWR from 'swr';
import { Settings as SettingsIcon, Key, Loader2, Check, X, Plus, Trash2, Activity, Info, Database } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { AutoApplySettingsCard } from '@/components/auto-apply-settings-card';

type ProviderKind = 'gemini' | 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'freeway';

interface ProviderRow {
  id: number;
  kind: ProviderKind;
  display_name: string;
  model: string;
  base_url: string | null;
  api_key_masked: string | null;
  is_active: boolean;
  is_creative: boolean;
  priority: number;
}

interface ProvidersResponse {
  providers: ProviderRow[];
  activeId: number | null;
  creativeId: number | null;
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
  { value: 'ollama', label: 'Ollama (Local)', hint: 'Local models — completely offline and free', needsKey: false, needsBaseUrl: true },
];

const KIND_PRESETS = {
  groq: { display_name: 'Groq (Free 1k RPD)', kind: 'openai-compatible' as const, model: 'llama-3.3-70b-versatile', base_url: 'https://api.groq.com/openai/v1' },
  cerebras: { display_name: 'Cerebras (Ultra-fast)', kind: 'openai-compatible' as const, model: 'llama-3.3-70b', base_url: 'https://api.cerebras.ai/v1' },
  mistral: { display_name: 'Mistral AI', kind: 'openai-compatible' as const, model: 'mistral-small-latest', base_url: 'https://api.mistral.ai/v1' },
  ollama: { display_name: 'Ollama default', kind: 'ollama' as const, model: 'llama3.2', base_url: 'http://localhost:11434/v1' },
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
    model: 'gemini-2.0-flash',
    base_url: '',
    api_key: '',
  });

  const providers = data?.providers ?? [];
  const active = providers.find((p) => p.is_active);

  const onKindChange = (kind: ProviderKind) => {
    const defaults: Record<ProviderKind, { display_name: string; model: string; base_url: string }> = {
      gemini: { display_name: 'Google Gemini', model: 'gemini-2.0-flash', base_url: '' },
      freeway: { display_name: 'Freeway (NVIDIA Cloud)', model: 'nvidia/nemotron-3-super-120b-a12b:free', base_url: '' },
      openai: { display_name: 'OpenAI', model: 'gpt-4o-mini', base_url: '' },
      anthropic: { display_name: 'Anthropic Claude', model: 'claude-3-5-haiku-20241022', base_url: '' },
      'openai-compatible': { display_name: 'Groq', model: 'llama-3.3-70b-versatile', base_url: 'https://api.groq.com/openai/v1' },
      ollama: { display_name: 'Ollama (Local)', model: 'llama3.2', base_url: 'http://localhost:11434/v1' },
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-2">
          <SettingsIcon className="h-6 w-6" />
          Settings
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure LLM providers and auto-apply controls.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        {/* Left 2 Columns: Primary Configuration Cards */}
        <div className="space-y-6 lg:col-span-2">
          {/* 1. LLM Providers */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">LLM Providers</CardTitle>
                <Button size="sm" onClick={() => setAdding((v) => !v)} variant={adding ? 'ghost' : 'default'}>
                  {adding ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {adding ? 'Cancel' : 'Add provider'}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {!data ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading providers…
                </div>
              ) : providers.length === 0 && !adding && (
                <p className="text-sm text-muted-foreground py-4 text-center">No providers yet. Click &quot;Add provider&quot;.</p>
              )}
              {providers.map((p) => (
                <div key={p.id} className={cn('rounded-md border p-3', p.is_active && 'border-success/50 bg-success/5')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{p.display_name}</span>
                        <Badge variant="outline" className="text-[10px] uppercase">{p.kind}</Badge>
                        {p.is_active && (
                          <Badge variant="success" className="text-[10px]">
                            <Activity className="h-2.5 w-2.5 mr-1" />
                            Active
                          </Badge>
                        )}
                        {p.is_creative && (
                          <Badge variant="info" className="text-[10px]">
                            Creative
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-mono">{p.model}</span>
                        {p.base_url && <span className="truncate">· {p.base_url}</span>}
                        {p.api_key_masked && (
                          <span className="flex items-center gap-1">
                            <Key className="h-3 w-3" />
                            {p.api_key_masked}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => test(p.id)} disabled={testing === p.id} className="h-7">
                        {testing === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Test'}
                      </Button>
                      <Button
                        size="sm"
                        variant={p.is_active ? 'outline' : 'default'}
                        onClick={() => activate(p.id, p.is_active)}
                        className="h-7"
                      >
                        {p.is_active ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        size="sm"
                        variant={p.is_creative ? 'outline' : 'ghost'}
                        onClick={() => setCreative(p.id, p.is_creative)}
                        className="h-7"
                        title="Use this provider for cover-letter and resume-variant generation"
                      >
                        {p.is_creative ? 'Clear creative' : 'Use for creative'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(p.id)} className="h-7 text-destructive hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}

              {adding && (
                <>
                  <Separator className="my-2" />
                  <div className="space-y-3 rounded-md border-2 border-dashed border-border p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">New provider</p>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Kind</label>
                      <select
                        value={form.kind}
                        onChange={(e) => onKindChange(e.target.value as ProviderKind)}
                        className="flex h-9 w-full rounded-md border border-input bg-card text-foreground px-3 py-1 text-sm font-medium shadow-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
                      >
                        {KIND_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value} className="bg-card text-foreground py-1">{o.label}</option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground">{KIND_OPTIONS.find((o) => o.value === form.kind)?.hint}</p>
                    </div>

                    {form.kind === 'openai-compatible' && (
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Quick presets</label>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(KIND_PRESETS).map(([key, p]) => (
                            <button
                              key={key}
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
                        <p className="text-[10px] text-muted-foreground">Stored in your local SQLite file at <code className="bg-muted px-1 rounded">data/hiresignal.db</code>. Never sent anywhere except to the provider you configured.</p>
                      </div>
                    )}

                    <Button onClick={create} disabled={submitting} size="sm">
                      {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Add
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
                {embInfo.provider === 'ollama' ? (
                  <p className="text-xs text-muted-foreground">
                    Local &amp; free (CPU-only). To run without Ollama, set <code className="bg-muted px-1 rounded">EMBEDDING_PROVIDER=gemini</code> (or <code className="bg-muted px-1 rounded">openai</code>) + <code className="bg-muted px-1 rounded">EMBEDDING_API_KEY</code>.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Cloud embeddings — no local Ollama needed.</p>
                )}
                {!embInfo.consistent && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                    <strong>Provider changed.</strong> Your data was embedded with <code className="font-mono">{embInfo.corpusSignature}</code> but the app is now set to <code className="font-mono">{embInfo.signature}</code>. New embeddings are blocked to keep matches valid. Either set it back, or re-embed everything: <code className="font-mono">npm run db:reset</code> then re-add your résumé and run a full sync.
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* 3. Auto-apply Controls */}
          <AutoApplySettingsCard />
        </div>

        {/* Right 1 Column: Help & Guidance */}
        <div className="space-y-6 lg:col-span-1">
          {!active && providers.length === 0 && (
            <Card className="border-info/30 bg-info/5">
              <CardContent className="p-4 flex items-start gap-3 text-sm">
                <Info className="h-4 w-4 mt-0.5 text-info shrink-0" />
                <div>
                  No providers configured. The app is using the default env-based provider (likely Gemini free tier).
                  Add a provider to use Groq (free 1k RPD), Cerebras, Mistral, OpenAI, Anthropic, or local Ollama.
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="bg-muted/20">
            <CardHeader>
              <CardTitle className="text-base font-medium">Provider Selection Guide</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="rounded-md border border-success/30 bg-success/5 p-2.5 text-xs text-success">
                <strong>Recommended for sharing:</strong> Google Gemini free tier — 1,500 req/day, no credit card needed.
                {' '}<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="underline">Get free key →</a>
              </div>
              <ol className="list-decimal list-inside text-muted-foreground space-y-2.5">
                <li>If a provider here is <strong>active</strong>, it&apos;s used for every LLM call.</li>
                <li>If <strong>none</strong> is active, the runtime falls back to env-based selection: <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">GEMINI_API_KEY</code> &gt; <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">ANTHROPIC_API_KEY</code> &gt; Ollama.</li>
                <li>Only one provider can be active at a time. Activating a new one deactivates the others.</li>
                <li>Search-grounded company briefs only work with Gemini. Other providers use training-data-only mode for that feature.</li>
                <li>Ollama (local models) is optional — install only if you want fully offline operation.</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
