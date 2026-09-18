'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ChevronRight, ExternalLink, ListChecks, Loader2, Search, Bell, AlertTriangle, User2, Calendar, Download, Trash2, X, FileText, Plus, Sparkles, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ScoreBadge } from '@/components/ui/score-badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useApplications, type Application } from '@/lib/hooks';
import { useDebouncedValue } from '@/lib/use-debounce';
import { CoverLetterView } from '@/components/cover-letter-view';

type ColumnKey = 'applied' | 'screening' | 'interview' | 'offer' | 'rejected';

const COLUMNS: Array<{ key: ColumnKey; label: string; dotClass: string }> = [
  { key: 'applied', label: 'Applied', dotClass: 'bg-info' },
  { key: 'screening', label: 'Screening', dotClass: 'bg-warning' },
  { key: 'interview', label: 'Interview', dotClass: 'bg-primary' },
  { key: 'offer', label: 'Offer', dotClass: 'bg-success' },
  { key: 'rejected', label: 'Rejected', dotClass: 'bg-destructive' },
];

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function isFollowUpDue(app: Application): boolean {
  if (!app.next_follow_up_at) return false;
  const due = new Date(app.next_follow_up_at).setHours(23, 59, 59, 999);
  return Date.now() >= due;
}

function isStale(app: Application): boolean {
  if (app.status !== 'applied') return false;
  const reference = app.applied_date || app.applied_at;
  const age = daysAgo(reference);
  return age !== null && age > 14;
}

export default function TrackerPage() {
  const { applications, isLoading, refresh } = useApplications();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<ColumnKey | null>(null);
  // Multi-select for bulk operations
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelected = () => setSelected(new Set());

  // Manual Add Application state
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newCompany, setNewCompany] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newStatus, setNewStatus] = useState<ColumnKey>('applied');
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10));
  const [newNotes, setNewNotes] = useState('');
  const [newRecruiterName, setNewRecruiterName] = useState('');
  const [newRecruiterContact, setNewRecruiterContact] = useState('');
  const [addingApp, setAddingApp] = useState(false);
  const [coverLetterModal, setCoverLetterModal] = useState<{ text: string; company: string; title: string } | null>(null);
  const [scoringJobId, setScoringJobId] = useState<number | null>(null);
  const scoringQueueRef = useRef<Set<number>>(new Set());

  // Automatically calculate tailored fit scores in the background for any application that doesn't have one yet
  useEffect(() => {
    const unscored = applications.filter(
      (a) => Boolean(a.has_tailored_resume) && a.tailored_score == null && a.job_id && !scoringQueueRef.current.has(a.job_id)
    );
    if (unscored.length === 0) return;

    let cancelled = false;
    async function autoScoreAll() {
      for (const app of unscored) {
        if (cancelled) break;
        scoringQueueRef.current.add(app.job_id);
        try {
          const res = await fetch(`/api/jobs/${app.job_id}/tailored-score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (res.ok && !cancelled) {
            const json = await res.json();
            if (json.score != null) {
              refresh();
            }
          }
        } catch {
          // ignore background errors
        }
      }
    }
    autoScoreAll();
    return () => {
      cancelled = true;
    };
  }, [applications, refresh]);

  const scoreTailored = async (jobId: number) => {
    if (!jobId || scoringJobId === jobId) return;
    setScoringJobId(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}/tailored-score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (json.error) {
        toast.error(json.error);
        return;
      }
      const score = Math.round(json.score);
      const delta = json.delta != null ? Math.round(json.delta) : null;
      toast.success(
        `Tailored match: ${score}% against job description${delta != null && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta} pts lift)` : ''}`
      );
      refresh();
    } catch {
      toast.error('Failed to calculate tailored match score');
    } finally {
      setScoringJobId(null);
    }
  };

  const handleAddApplication = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompany.trim() || !newTitle.trim()) {
      toast.error('Company and Job Title are required');
      return;
    }
    setAddingApp(true);
    try {
      const res = await fetch('/api/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: newCompany.trim(),
          title: newTitle.trim(),
          location: newLocation.trim() || undefined,
          url: newUrl.trim() || undefined,
          status: newStatus,
          applied_date: newDate,
          notes: newNotes.trim() || undefined,
          recruiter_name: newRecruiterName.trim() || undefined,
          recruiter_contact: newRecruiterContact.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error();
      toast.success('Application added to Tracker!');
      setShowAddDialog(false);
      setNewCompany('');
      setNewTitle('');
      setNewLocation('');
      setNewUrl('');
      setNewNotes('');
      setNewRecruiterName('');
      setNewRecruiterContact('');
      refresh();
    } catch {
      toast.error('Failed to add application');
    } finally {
      setAddingApp(false);
    }
  };

  // Optimistic: update locally first, fire request in background, revert on error.
  const updateStatus = async (app: Application, newStatus: string) => {
    const optimistic = applications.map((a) =>
      a.job_id === app.job_id ? { ...a, status: newStatus, last_status_change_at: new Date().toISOString() } : a
    );
    refresh({ applications: optimistic }, { revalidate: false });
    toast.success(`Moved to ${newStatus}`);

    try {
      const res = await fetch('/api/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: app.job_id,
          status: newStatus,
          notes: app.notes,
          recruiter_name: app.recruiter_name,
          recruiter_contact: app.recruiter_contact,
          next_follow_up_at: app.next_follow_up_at,
        }),
      });
      if (!res.ok) throw new Error();
      // Quietly revalidate to pick up server-side last_status_change_at
      refresh();
    } catch {
      toast.error('Save failed — reverting');
      refresh(); // re-fetch authoritative state
    }
  };

  const saveNote = async (app: Application, newNote: string) => {
    const optimistic = applications.map((a) => (a.job_id === app.job_id ? { ...a, notes: newNote } : a));
    refresh({ applications: optimistic }, { revalidate: false });
    setEditingNoteId(null);

    try {
      const res = await fetch('/api/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: app.job_id,
          status: app.status,
          notes: newNote,
          recruiter_name: app.recruiter_name,
          recruiter_contact: app.recruiter_contact,
          next_follow_up_at: app.next_follow_up_at,
        }),
      });
      if (!res.ok) throw new Error();
      toast.success('Note saved');
    } catch {
      toast.error('Save failed');
      refresh();
    }
  };

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return applications;
    return applications.filter(
      (a) =>
        a.company.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        (a.recruiter_name || '').toLowerCase().includes(q)
    );
  }, [applications, debouncedQuery]);

  const followUpDue = useMemo(() => filtered.filter(isFollowUpDue), [filtered]);

  // CSV export: build client-side, trigger a download. Quotes RFC4180-style.
  const exportCsv = () => {
    const cols = [
      'company', 'title', 'location', 'status', 'applied_date',
      'recruiter_name', 'recruiter_contact', 'next_follow_up_at',
      'last_status_change_at', 'url', 'notes',
    ] as const;
    const escape = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const header = cols.join(',');
    const rows = applications.map((a) =>
      cols.map((c) => escape((a as unknown as Record<string, unknown>)[c])).join(',')
    );
    const csv = [header, ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `hiresignal-applications-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${applications.length} application${applications.length === 1 ? '' : 's'}`);
  };

  // Bulk operations on selected applications.
  const bulkUpdateStatus = async (newStatus: string) => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const optimistic = applications.map((a) =>
      ids.includes(a.id) ? { ...a, status: newStatus, last_status_change_at: new Date().toISOString() } : a
    );
    refresh({ applications: optimistic }, { revalidate: false });
    toast.success(`Moving ${ids.length} to ${newStatus}…`);
    try {
      await Promise.all(ids.map((id) => {
        const app = applications.find((a) => a.id === id);
        if (!app) return Promise.resolve();
        return fetch('/api/outcomes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: app.job_id,
            status: newStatus,
            notes: app.notes,
            recruiter_name: app.recruiter_name,
            recruiter_contact: app.recruiter_contact,
            next_follow_up_at: app.next_follow_up_at,
          }),
        });
      }));
      clearSelected();
      refresh();
    } catch {
      toast.error('Bulk update failed — reverting');
      refresh();
    }
  };

  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} application${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    const optimistic = applications.filter((a) => !selected.has(a.id));
    refresh({ applications: optimistic }, { revalidate: false });
    try {
      await Promise.all(ids.map((id) => fetch(`/api/outcomes/${id}`, { method: 'DELETE' })));
      toast.success(`Deleted ${ids.length}`);
      clearSelected();
      refresh();
    } catch {
      toast.error('Delete failed — reverting');
      refresh();
    }
  };

  // Show spinner only on first load (no cached data). Background revalidation is silent.
  if (isLoading && applications.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Tracker</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {applications.length === 0
              ? 'Applications you send will appear here.'
              : `${applications.length} application${applications.length === 1 ? '' : 's'} across ${COLUMNS.length} stages.`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {applications.length > 0 && (
            <div className="flex items-center gap-2 flex-1 sm:max-w-md">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Filter by company, title, recruiter..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-8"
                />
              </div>
              <Button variant="outline" size="sm" onClick={exportCsv} title="Export all applications as CSV">
                <Download className="h-3.5 w-3.5" />
                CSV
              </Button>
            </div>
          )}
          <Button size="sm" onClick={() => setShowAddDialog(true)} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Add Application
          </Button>
        </div>
      </div>

      {/* Bulk action bar — appears when at least one card is selected */}
      {selected.size > 0 && (
        <div className="sticky top-14 z-30 -mx-4 sm:mx-0 bg-background/95 backdrop-blur border rounded-md px-3 py-2 flex flex-wrap items-center gap-2 shadow-sm">
          <span className="text-xs font-medium text-muted-foreground">
            {selected.size} selected
          </span>
          <Separator orientation="vertical" className="h-5" />
          <span className="text-xs text-muted-foreground">Move to:</span>
          {COLUMNS.map((c) => (
            <Button
              key={c.key}
              variant="ghost"
              size="sm"
              onClick={() => bulkUpdateStatus(c.key)}
              className="h-7 text-xs"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full mr-1', c.dotClass)} />
              {c.label}
            </Button>
          ))}
          <Separator orientation="vertical" className="h-5" />
          <Button variant="ghost" size="sm" onClick={bulkDelete} className="h-7 text-xs text-destructive hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
          <div className="ml-auto">
            <Button variant="ghost" size="sm" onClick={clearSelected} className="h-7 text-xs text-muted-foreground">
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>
        </div>
      )}

      {applications.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center space-y-3">
            <ListChecks className="mx-auto h-8 w-8 text-muted-foreground" />
            <div className="space-y-1">
              <p className="font-medium">No applications yet</p>
              <p className="text-sm text-muted-foreground">
                Apply to a match and it will appear here. Generating a cover letter on its own doesn&apos;t count as applying.
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/">Back to matches</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Needs follow-up */}
          {followUpDue.length > 0 && (
            <Card className="border-warning/30 bg-warning/5">
              <CardContent className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Bell className="h-4 w-4 text-warning" />
                  <h2 className="font-semibold text-sm">
                    Needs follow-up
                    <span className="ml-2 text-xs text-muted-foreground tabular">({followUpDue.length})</span>
                  </h2>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {followUpDue.map((app) => (
                    <Link
                      key={app.id}
                      href={`/job/${app.job_id}`}
                      className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm hover:bg-accent transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="font-medium truncate">{app.company}</p>
                        <p className="text-xs text-muted-foreground truncate">{app.title}</p>
                      </div>
                      <div className="text-xs text-warning tabular shrink-0 flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {app.next_follow_up_at}
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Kanban */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-5">
            {COLUMNS.map((col) => {
              const colApps = filtered
                .filter((a) => a.status === col.key)
                .sort((a, b) => {
                  const rawA = a.applied_at || a.submitted_at || a.last_status_change_at || a.applied_date || '';
                  const rawB = b.applied_at || b.submitted_at || b.last_status_change_at || b.applied_date || '';
                  const timeA = new Date(rawA.replace(' ', 'T')).getTime() || 0;
                  const timeB = new Date(rawB.replace(' ', 'T')).getTime() || 0;
                  if (timeB !== timeA) return timeB - timeA;
                  return (b.id ?? 0) - (a.id ?? 0);
                });
              const isDropTarget = dragOverCol === col.key;
              return (
                <div
                  key={col.key}
                  className={cn(
                    'space-y-3 rounded-md p-1 transition-colors',
                    isDropTarget && 'bg-accent/40 ring-1 ring-ring',
                  )}
                  onDragOver={(e) => {
                    if (draggingId === null) return;
                    e.preventDefault();
                    if (dragOverCol !== col.key) setDragOverCol(col.key);
                  }}
                  onDragLeave={(e) => {
                    // Only clear when leaving the column container, not its children
                    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                    if (dragOverCol === col.key) setDragOverCol(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverCol(null);
                    const id = draggingId;
                    setDraggingId(null);
                    if (id === null) return;
                    const app = applications.find((a) => a.id === id);
                    if (!app || app.status === col.key) return;
                    updateStatus(app, col.key);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', col.dotClass)} />
                    <span className="text-sm font-medium">{col.label}</span>
                    <span className="text-xs text-muted-foreground tabular">({colApps.length})</span>
                  </div>
                  <Separator />
                  <div className="space-y-2 min-h-[100px]">
                    {colApps.map((app) => {
                      const age = daysAgo(app.applied_date || app.applied_at);
                      const stageDays = daysAgo(app.last_status_change_at || app.applied_at);
                      const stale = isStale(app);
                      const followUp = isFollowUpDue(app);
                      const isExpanded = expanded === app.id;
                      const editing = editingNoteId === app.id;

                      const isSelected = selected.has(app.id);
                      return (
                        <Card
                          key={app.id}
                          draggable
                          onDragStart={(e) => {
                            setDraggingId(app.id);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragEnd={() => {
                            setDraggingId(null);
                            setDragOverCol(null);
                          }}
                          onClick={(e) => {
                            if (editing) return;
                            // Shift-click to add to selection
                            if (e.shiftKey) {
                              e.preventDefault();
                              toggleSelected(app.id);
                              return;
                            }
                            setExpanded(isExpanded ? null : app.id);
                          }}
                          className={cn(
                            'cursor-pointer transition-all hover:border-border/80 overflow-hidden',
                            isExpanded && 'ring-1 ring-ring',
                            isSelected && 'ring-1 ring-info',
                            stale && !isExpanded && 'border-warning/30',
                            followUp && !isExpanded && 'border-info/30',
                            draggingId === app.id && 'opacity-50',
                          )}
                        >
                          <CardContent className="p-3 space-y-1.5">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-start gap-1.5 min-w-0 flex-1">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={() => toggleSelected(app.id)}
                                  className="mt-0.5 h-3 w-3 cursor-pointer accent-info"
                                  aria-label={`Select ${app.company}`}
                                />
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium truncate">{app.company}</p>
                                  <p className="text-xs text-muted-foreground truncate">{app.title}</p>
                                </div>
                              </div>
                              <ChevronRight
                                className={cn(
                                  'h-4 w-4 text-muted-foreground transition-transform shrink-0',
                                  isExpanded && 'rotate-90'
                                )}
                              />
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground tabular">
                              <span>{age === 0 ? 'Today' : age === null ? '—' : `${age}d ago`}</span>
                              {stageDays !== null && stageDays >= 1 && (
                                <span className="text-muted-foreground/80">
                                  · {stageDays}d in {col.label.toLowerCase()}
                                </span>
                              )}
                              {stale && (
                                <Badge variant="warning" className="px-1 py-0 text-[10px]">
                                  <AlertTriangle className="mr-0.5 h-2.5 w-2.5" />
                                  stale
                                </Badge>
                              )}
                              {followUp && (
                                <Badge variant="info" className="px-1 py-0 text-[10px]">
                                  <Bell className="mr-0.5 h-2.5 w-2.5" />
                                  follow-up
                                </Badge>
                              )}
                              {Boolean(app.has_tailored_resume) && (
                                <div className="flex items-center gap-1">
                                  <Badge variant="success" className="px-1 py-0 text-[10px] font-normal gap-0.5">
                                    <FileText className="h-2.5 w-2.5" />
                                    tailored
                                  </Badge>
                                  {app.tailored_score != null ? (
                                    <span
                                      className={cn(
                                        'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold tabular',
                                        app.tailored_score >= 55
                                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                                          : app.tailored_score >= 40
                                          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                                          : 'bg-muted text-muted-foreground border border-border',
                                      )}
                                      title={`Tailored résumé match score: ${Math.round(app.tailored_score)}% against JD${app.default_score != null ? ` (original: ${Math.round(app.default_score)}%)` : ''}`}
                                    >
                                      <Sparkles className="h-2.5 w-2.5" />
                                      {Math.round(app.tailored_score)}% match
                                    </span>
                                  ) : (
                                    <span
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground bg-muted/60 border border-border"
                                      title="Calculating tailored match score in background..."
                                    >
                                      <Loader2 className="h-2.5 w-2.5 animate-spin text-primary" />
                                      evaluating...
                                    </span>
                                  )}
                                </div>
                              )}
                              {app.recruiter_name && (
                                <span className="flex items-center gap-0.5 normal-nums">
                                  <User2 className="h-3 w-3" />
                                  {app.recruiter_name}
                                </span>
                              )}
                            </div>

                            {isExpanded && (
                              <div className="pt-2 space-y-2 border-t border-border/60" onClick={(e) => e.stopPropagation()}>
                                {Boolean(app.has_tailored_resume) && (
                                  <div className="rounded-md border p-2.5 bg-muted/30 space-y-1.5">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-1.5">
                                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                          Tailored Résumé Match Score
                                        </p>
                                      </div>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => scoreTailored(app.job_id)}
                                        disabled={scoringJobId === app.job_id}
                                        className="h-6 text-[10px] px-2 gap-1 text-muted-foreground hover:text-foreground"
                                      >
                                        {scoringJobId === app.job_id ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <RefreshCw className="h-3 w-3" />
                                        )}
                                        {app.tailored_score != null ? 'Re-calculate' : 'Calculating...'}
                                      </Button>
                                    </div>

                                    {app.tailored_score != null ? (
                                      <div className="flex items-center gap-3 pt-0.5">
                                        <ScoreBadge score={app.tailored_score / 100} size="md" />
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-1.5 flex-wrap">
                                            <span className="text-xs font-semibold text-foreground">
                                              {Math.round(app.tailored_score)}% fit against job description
                                            </span>
                                            {app.default_score != null && (
                                              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                                                <span>(original: {Math.round(app.default_score)}%)</span>
                                                {app.tailored_score !== app.default_score && (
                                                  <span
                                                    className={cn(
                                                      'font-semibold',
                                                      app.tailored_score > app.default_score
                                                        ? 'text-emerald-600 dark:text-emerald-400'
                                                        : 'text-destructive',
                                                    )}
                                                  >
                                                    {app.tailored_score > app.default_score
                                                      ? `▲ +${Math.round(app.tailored_score - app.default_score)} pts lift`
                                                      : `▼ ${Math.round(app.tailored_score - app.default_score)} pts`}
                                                  </span>
                                                )}
                                              </span>
                                            )}
                                          </div>
                                          <p className="text-[11px] text-muted-foreground mt-0.5">
                                            Score re-evaluated using the AI-tailored résumé against the employer's job description.
                                          </p>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
                                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                                        <span>Automatically evaluating fit score against job description...</span>
                                      </div>
                                    )}
                                  </div>
                                )}
                                {app.cover_letter && (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Cover letter
                                      </p>
                                      <button
                                        type="button"
                                        onClick={() => setCoverLetterModal({ text: app.cover_letter!, company: app.company, title: app.title })}
                                        className="text-[10px] text-primary hover:underline font-medium"
                                      >
                                        View full letter
                                      </button>
                                    </div>
                                    <p className="text-xs text-foreground/80 line-clamp-3">
                                      {app.cover_letter.slice(0, 180)}…
                                    </p>
                                  </div>
                                )}

                                <div>
                                  <div className="flex items-center justify-between mb-1">
                                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                      Notes
                                    </p>
                                    {!editing && (
                                      <button
                                        onClick={() => {
                                          setEditingNoteId(app.id);
                                          setNoteDraft(app.notes || '');
                                        }}
                                        className="text-[10px] text-muted-foreground hover:text-foreground"
                                      >
                                        edit
                                      </button>
                                    )}
                                  </div>
                                  {editing ? (
                                    <div className="space-y-1">
                                      <textarea
                                        value={noteDraft}
                                        onChange={(e) => setNoteDraft(e.target.value)}
                                        rows={3}
                                        autoFocus
                                        placeholder="Add notes..."
                                        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                      />
                                      <div className="flex gap-1.5">
                                        <Button size="sm" onClick={() => saveNote(app, noteDraft)} className="h-6 text-[10px] px-2">
                                          Save
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          onClick={() => setEditingNoteId(null)}
                                          className="h-6 text-[10px] px-2"
                                        >
                                          Cancel
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="text-xs text-foreground/80">
                                      {app.notes || <span className="text-muted-foreground italic">No notes</span>}
                                    </p>
                                  )}
                                </div>

                                {(app.recruiter_contact || app.next_follow_up_at) && (
                                  <div className="space-y-1 text-xs">
                                    {app.recruiter_contact && (
                                      <p className="flex items-center gap-1.5 text-muted-foreground">
                                        <User2 className="h-3 w-3" />
                                        <span className="truncate">{app.recruiter_contact}</span>
                                      </p>
                                    )}
                                    {app.next_follow_up_at && (
                                      <p className="flex items-center gap-1.5 text-muted-foreground tabular">
                                        <Calendar className="h-3 w-3" />
                                        Follow up: {app.next_follow_up_at}
                                      </p>
                                    )}
                                  </div>
                                )}

                                <div className="flex flex-wrap gap-1 pt-1">
                                  {COLUMNS.filter((c) => c.key !== app.status).map((c) => (
                                    <button
                                      key={c.key}
                                      onClick={() => updateStatus(app, c.key)}
                                      className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                                    >
                                      <span className={cn('h-1.5 w-1.5 rounded-full', c.dotClass)} />
                                      {c.label}
                                    </button>
                                  ))}
                                </div>

                                {app.has_tailored_resume ? (
                                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                                    <Button
                                      asChild
                                      variant="outline"
                                      size="sm"
                                      className="h-7 text-[11px] px-2 justify-center gap-1 min-w-0"
                                      title="View AI-tailored résumé"
                                    >
                                      <a
                                        href={`/api/jobs/${app.job_id}/resume.pdf?source=tailored`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-center gap-1 min-w-0 w-full"
                                      >
                                        <Sparkles className="h-3 w-3 text-primary shrink-0" />
                                        <span className="truncate font-medium">Tailored</span>
                                        <ExternalLink className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                      </a>
                                    </Button>
                                    <Button
                                      asChild
                                      variant="outline"
                                      size="sm"
                                      className="h-7 text-[11px] px-2 justify-center gap-1 min-w-0 text-muted-foreground hover:text-foreground"
                                      title="View original un-tailored résumé"
                                    >
                                      <a
                                        href={`/api/jobs/${app.job_id}/resume.pdf?source=original`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-center gap-1 min-w-0 w-full"
                                      >
                                        <FileText className="h-3 w-3 shrink-0" />
                                        <span className="truncate font-medium">Original</span>
                                        <ExternalLink className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                                      </a>
                                    </Button>
                                  </div>
                                ) : (
                                  <div className="pt-1">
                                    <Button
                                      asChild
                                      variant="outline"
                                      size="sm"
                                      className="h-7 w-full text-xs justify-start px-2 gap-1.5 min-w-0"
                                    >
                                      <a
                                        href={`/api/jobs/${app.job_id}/resume.pdf?source=original`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-between min-w-0 w-full"
                                      >
                                        <span className="flex items-center gap-1.5 truncate">
                                          <FileText className="h-3 w-3 text-primary shrink-0" />
                                          <span className="truncate">View résumé</span>
                                        </span>
                                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                                      </a>
                                    </Button>
                                  </div>
                                )}

                                <Button
                                  asChild
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-full justify-start px-2"
                                >
                                  <Link href={`/job/${app.job_id}`} className="flex items-center justify-between w-full">
                                    <span>View details</span>
                                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                                  </Link>
                                </Button>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Manual Add Application Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleAddApplication} className="space-y-4">
            <div>
              <DialogTitle className="text-lg font-semibold">Add Application to Tracker</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-1">
                Record a job you applied to manually or on an external site.
              </DialogDescription>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Company *</label>
                <Input
                  required
                  placeholder="e.g. Google"
                  value={newCompany}
                  onChange={(e) => setNewCompany(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Job Title *</label>
                <Input
                  required
                  placeholder="e.g. Senior Data Engineer"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Location</label>
                <Input
                  placeholder="e.g. Bengaluru / Remote"
                  value={newLocation}
                  onChange={(e) => setNewLocation(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Job Posting URL</label>
                <Input
                  placeholder="https://..."
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Stage</label>
                <select
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value as ColumnKey)}
                  className="flex h-9 w-full rounded-md border border-input bg-card text-foreground px-3 py-1 text-sm font-medium shadow-xs hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
                >
                  {COLUMNS.map((col) => (
                    <option key={col.key} value={col.key} className="bg-card text-foreground py-1">
                      {col.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Applied Date</label>
                <Input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Recruiter Name</label>
                <Input
                  placeholder="e.g. Sarah Jenkins"
                  value={newRecruiterName}
                  onChange={(e) => setNewRecruiterName(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Recruiter Contact</label>
                <Input
                  placeholder="email or LinkedIn"
                  value={newRecruiterContact}
                  onChange={(e) => setNewRecruiterContact(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Notes</label>
              <textarea
                rows={2}
                placeholder="Applied via LinkedIn, referral from..., interview prep notes"
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t">
              <Button type="button" variant="ghost" onClick={() => setShowAddDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={addingApp} className="gap-1.5">
                {addingApp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Add Application
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Cover Letter View Dialog */}
      <Dialog open={!!coverLetterModal} onOpenChange={(v) => { if (!v) setCoverLetterModal(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {coverLetterModal && (
            <CoverLetterView
              markdown={coverLetterModal.text}
              company={coverLetterModal.company}
              jobTitle={coverLetterModal.title}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
