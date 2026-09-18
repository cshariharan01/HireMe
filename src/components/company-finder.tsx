'use client';

import { useCallback, useEffect, useState } from 'react';
import { Search, Loader2, Plus, Download, Building2, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useDebouncedValue } from '@/lib/use-debounce';

/**
 * Search ~37,000 company career boards and add one in a click.
 *
 * WHY THIS EXISTS: seeding a company used to mean hand-hunting its careers URL, and for Workday
 * that was close to impossible — a pull needs tenant + data-centre host + site, none of which can be
 * derived from a company name (probing 15 plausible combinations for Kaiser, HCA, Providence, Cigna
 * and Elevance found zero working boards). Every row here arrives WITH its board URL.
 *
 * The directory is only a directory: jobs are still pulled fresh by our own adapters.
 */

interface Hit {
  ats: string;
  name: string;
  slug: string;
  url: string | null;
  match: 'exact' | 'starts-with' | 'word' | 'partial';
}

/** A `partial` hit is a guess — "Elevance" matches "Relevance AI" — so it is labelled as one. */
const MATCH_TONE: Record<Hit['match'], 'success' | 'info' | 'muted'> = {
  exact: 'success',
  'starts-with': 'success',
  word: 'info',
  partial: 'muted',
};

export function CompanyFinder() {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query, 300);
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`/api/companies/directory?q=${encodeURIComponent(q)}&limit=15`);
      const j = await r.json();
      setHits(j.results || []);
      if (typeof j.total === 'number') setTotal(j.total);
      setEmpty(!!j.empty);
    } catch {
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void search(debounced);
  }, [debounced, search]);

  // Show the directory size (and whether it needs downloading) before the first search.
  useEffect(() => {
    fetch('/api/companies/directory?q=')
      .then((r) => r.json())
      .then((j) => {
        if (typeof j.total === 'number') setTotal(j.total);
        setEmpty(!!j.empty);
      })
      .catch(() => {});
  }, []);

  const addCompany = async (hit: Hit, pullNow: boolean) => {
    if (!hit.url) {
      toast.error('That entry has no board URL');
      return;
    }
    const key = `${hit.ats}:${hit.slug}`;
    setBusy(key);
    try {
      // Always seed it, so every future `npm run discover` includes the company.
      const seed = await fetch('/api/companies/directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: hit.url, name: hit.name }),
      });
      const seedJson = await seed.json();
      if (!seed.ok) throw new Error(seedJson.error || 'Could not add to the seed list');

      if (!pullNow) {
        toast.success(seedJson.message);
        setAdded((prev) => new Set(prev).add(key));
        return;
      }

      toast.message(`Pulling ${hit.name}'s board…`, { description: 'A big board can take a minute.' });
      const res = await fetch('/api/jobs/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: hit.url }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Pull failed');
      setAdded((prev) => new Set(prev).add(key));
      toast.success(
        `${hit.name}: ${json.added ?? 0} new job${json.added === 1 ? '' : 's'}`,
        { description: 'Run `npm run embed` to make them matchable.' },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Building2 className="h-4 w-4" /> Find a company
        </CardTitle>
        <CardDescription>
          Search {total ? total.toLocaleString() : 'thousands of'} company career boards by name and
          add one in a click — no hunting for the careers URL. Jobs are pulled fresh by HireSignal;
          the directory only says which system a company uses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {empty ? (
          <div className="rounded-lg border border-dashed p-4 text-sm">
            <p className="font-medium flex items-center gap-2">
              <Download className="h-4 w-4" /> Directory not downloaded yet
            </p>
            <p className="mt-1 text-muted-foreground">
              Run <code className="rounded bg-muted px-1">npm run sync:directory</code> once (~7MB) to
              load ~37,000 company boards, then search here.
            </p>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Company name — e.g. Cleveland Clinic, Humana, Stripe"
                className="pl-9"
              />
              {loading && (
                <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>

            {query.trim().length >= 2 && !loading && hits.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No match. The company may use an ATS we can&apos;t pull yet — paste its careers URL in
                the tab above instead.
              </p>
            )}

            <div className="space-y-1.5">
              {hits.map((h) => {
                const key = `${h.ats}:${h.slug}`;
                const isBusy = busy === key;
                const isAdded = added.has(key);
                return (
                  <div key={key} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{h.name}</span>
                        <Badge variant={MATCH_TONE[h.match]} className="shrink-0 text-[10px]">
                          {h.ats}
                        </Badge>
                        {h.match === 'partial' && (
                          <Badge variant="warning" className="shrink-0 text-[10px]">
                            loose match
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{h.url}</p>
                    </div>
                    {isAdded ? (
                      <Badge variant="success" className="shrink-0 gap-1 text-[10px]">
                        <Check className="h-3 w-3" /> added
                      </Badge>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          disabled={isBusy}
                          onClick={() => addCompany(h, false)}
                          title="Add to the seed list — pulled on the next sync"
                        >
                          <Plus className="h-3.5 w-3.5" /> Seed
                        </Button>
                        <Button
                          size="sm"
                          className="h-7"
                          disabled={isBusy}
                          onClick={() => addCompany(h, true)}
                          title="Add and pull the whole board now"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          Add &amp; pull
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
