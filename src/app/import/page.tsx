'use client';

import { useEffect, useState, useCallback } from 'react';
import { Clipboard, PenLine, Plus, Loader2, Info, Database, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { CompanyFinder } from '@/components/company-finder';

interface SourceStat {
  source: string;
  count: number;
  embedded: number;
  healthcare_it: number;
}

export default function ImportPage() {
  const [company, setCompany] = useState('');
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [source, setSource] = useState('linkedin');
  const [submitting, setSubmitting] = useState(false);
  const [stats, setStats] = useState<SourceStat[]>([]);
  const [total, setTotal] = useState(0);
  const [bulkText, setBulkText] = useState('');
  const [mode, setMode] = useState<'form' | 'paste' | 'discover' | 'find'>('paste');
  const [discoverInput, setDiscoverInput] = useState('');
  const [discovering, setDiscovering] = useState(false);

  const fetchStats = useCallback(async () => {
    const res = await fetch('/api/jobs/import');
    const data = await res.json();
    setStats(data.stats || []);
    setTotal(data.total || 0);
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/jobs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company, title, location, description, url, source }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
      } else {
        toast.success(
          `Job added. ${data.embedded ? 'Embedding generated.' : 'Run npm run embed.'}${data.domainPriority ? ' Domain priority detected.' : ''}`
        );
        setCompany('');
        setTitle('');
        setLocation('');
        setDescription('');
        setUrl('');
        fetchStats();
      }
    } catch {
      toast.error('Failed to import job');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDiscover = async () => {
    if (!discoverInput.trim()) return;
    setDiscovering(true);
    try {
      const res = await fetch('/api/jobs/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: discoverInput.trim() }),
      });
      const data = await res.json();
      if (data.error) toast.error(data.error);
      else {
        toast.success(data.message || `Discovered ${data.added} jobs`);
        setDiscoverInput('');
        fetchStats();
      }
    } catch {
      toast.error('Discovery failed');
    } finally {
      setDiscovering(false);
    }
  };

  const handleBulkParse = async () => {
    if (!bulkText.trim()) return;
    setSubmitting(true);
    const lines = bulkText.split('\n').filter((l) => l.trim());
    const parsed = { company: '', title: '', location: '', description: '' };
    for (const line of lines) {
      const l = line.trim();
      if (
        !parsed.title &&
        (l.toLowerCase().includes('engineer') ||
          l.toLowerCase().includes('architect') ||
          l.toLowerCase().includes('developer') ||
          l.toLowerCase().includes('manager') ||
          l.toLowerCase().includes('lead') ||
          l.toLowerCase().includes('director'))
      ) {
        parsed.title = l;
      } else if (!parsed.company && l.length < 60 && !l.includes(':') && lines.indexOf(line) < 3) {
        parsed.company = l;
      } else if (!parsed.location && /remote|hybrid|onsite|india|usa|new york|san francisco|berlin|london/i.test(l)) {
        parsed.location = l;
      } else {
        parsed.description += l + '\n';
      }
    }
    if (!parsed.title && !parsed.company) {
      parsed.description = bulkText;
      parsed.title = lines[0]?.slice(0, 100) || 'Untitled Position';
      parsed.company = 'Unknown Company';
    }
    setCompany(parsed.company);
    setTitle(parsed.title);
    setLocation(parsed.location);
    setDescription(parsed.description.trim());
    setMode('form');
    setSubmitting(false);
    toast.success('Parsed. Review the fields below and submit.');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Import</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add jobs manually from LinkedIn, Naukri, or any portal. Full paste-parse pipeline — no scraping needed.
        </p>
      </div>

      {/* Stats */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4" />
              Job sources
            </CardTitle>
            <Badge variant="outline" className="tabular">
              {total} total
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {stats.map((s) => (
              <div key={s.source} className="rounded-md border bg-muted/30 p-3">
                <p className="text-2xl font-semibold tabular">{s.count}</p>
                <p className="text-xs font-medium capitalize">{s.source}</p>
                <p className="text-[10px] text-muted-foreground">
                  {s.embedded} embedded
                  {s.healthcare_it > 0 ? ` · ${s.healthcare_it} priority` : ''}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <div className="inline-flex rounded-md border p-0.5 bg-muted/30">
        <button
          onClick={() => setMode('paste')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
            mode === 'paste' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Clipboard className="h-3.5 w-3.5" />
          Paste JD
        </button>
        <button
          onClick={() => setMode('form')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
            mode === 'form' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <PenLine className="h-3.5 w-3.5" />
          Manual fields
        </button>
        <button
          onClick={() => setMode('discover')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
            mode === 'discover' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Database className="h-3.5 w-3.5" />
          Discover from career page
        </button>
        <button
          onClick={() => setMode('find')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
            mode === 'find' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Building2 className="h-3.5 w-3.5" />
          Find a company
        </button>
      </div>

      {mode === 'find' && <CompanyFinder />}

      {mode === 'discover' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Discover a whole company&apos;s board</CardTitle>
            <CardDescription>
              Enter a company name or paste its careers-page URL. HireSignal detects the ATS
              (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee) and pulls every open role —
              or crawls the page if it&apos;s custom. Kept roles are senior/technical across all industries.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={discoverInput}
                onChange={(e) => setDiscoverInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleDiscover(); }}
                placeholder="e.g. Cohere Health  —or—  https://boards.greenhouse.io/acme"
                disabled={discovering}
              />
              <Button onClick={handleDiscover} disabled={discovering || !discoverInput.trim()}>
                {discovering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {discovering ? 'Discovering…' : 'Discover'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              New jobs are saved without embeddings — run <code className="rounded bg-muted px-1">npm run embed</code> to make them show in matches.
            </p>
          </CardContent>
        </Card>
      )}

      {mode === 'paste' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Paste from LinkedIn or any job site</CardTitle>
            <CardDescription>
              Copy the full posting, drop it below, and we&apos;ll extract company, title, location, and description.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={10}
              placeholder={
                "Paste job description here...\n\nExample:\nSolution Architect - Healthcare Integration\nOptum\nRemote - India\n\nWe're looking for..."
              }
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
            />
            <Button onClick={handleBulkParse} disabled={submitting || !bulkText.trim()} size="sm">
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clipboard className="h-3.5 w-3.5" />}
              Parse &amp; review
            </Button>
          </CardContent>
        </Card>
      ) : mode === 'form' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Manual entry</CardTitle>
            <CardDescription>Every field is free-form. * = required.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Company *
                  </label>
                  <Input value={company} onChange={(e) => setCompany(e.target.value)} required placeholder="Optum" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Title *
                  </label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    placeholder="Solution Architect - Healthcare"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Location
                  </label>
                  <Input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="Remote — India"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Source
                  </label>
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-card text-foreground px-3 py-1 text-sm font-medium shadow-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
                  >
                    <option value="linkedin" className="bg-card text-foreground py-1">LinkedIn</option>
                    <option value="naukri" className="bg-card text-foreground py-1">Naukri</option>
                    <option value="indeed" className="bg-card text-foreground py-1">Indeed</option>
                    <option value="hirist" className="bg-card text-foreground py-1">Hirist</option>
                    <option value="cutshort" className="bg-card text-foreground py-1">Cutshort</option>
                    <option value="company-site" className="bg-card text-foreground py-1">Company site</option>
                    <option value="referral" className="bg-card text-foreground py-1">Referral</option>
                    <option value="manual" className="bg-card text-foreground py-1">Other</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Job URL</label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." type="url" />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={6}
                  placeholder="Paste the full job description..."
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>

              <Button type="submit" disabled={submitting} size="sm">
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Add job
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Separator />

      <Card className="bg-muted/20">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <Info className="h-4 w-4 mt-0.5 text-muted-foreground" />
            <div className="space-y-2 text-sm">
              <p className="font-medium">Using this with LinkedIn or Naukri</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Search on the portal (e.g. &quot;HL7 FHIR Architect Remote&quot;).</li>
                <li>Open a posting you care about.</li>
                <li>Copy the title, company, location, and full description.</li>
                <li>Paste everything above and hit &quot;Parse &amp; review&quot;.</li>
                <li>Verify the auto-extracted fields, then &quot;Add job&quot;.</li>
              </ol>
              <p className="text-muted-foreground">
                You can skip parsing and just switch to &quot;Manual fields&quot; if you prefer.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
