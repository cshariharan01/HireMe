'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Loader2, Trash2, Pencil, Check, X, MessageSquareText } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

/**
 * Review, edit and delete the answers auto-apply reuses.
 *
 * WHY THIS EXISTS: `screening_answers` had no interface whatsoever. Answers were cached by a hash
 * of the question and replayed on every future application that asked the same thing — so one
 * wrong answer (the work-authorisation question being the obvious hazard) silently propagated
 * forever with no way to see it, let alone fix it. Meanwhile error messages told the user to
 * "Enable via /settings", where no such control existed.
 */

interface Answer {
  id: number;
  question: string;
  answer: string;
  category: string | null;
  used_count: number;
  last_used_at: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

// The two categories where a wrong cached answer does real damage get a louder badge.
const CATEGORY_TONE: Record<string, 'info' | 'warning' | 'muted'> = {
  work_auth: 'warning',
  sponsorship: 'warning',
  comp: 'info',
  notice: 'info',
};

export function ScreeningAnswersCard() {
  const { data, isLoading, mutate } = useSWR<{ answers: Answer[] }>(
    '/api/apply/screening-answers',
    fetcher,
  );
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const answers = data?.answers ?? [];

  const startEdit = (a: Answer) => {
    setEditingId(a.id);
    setDraft(a.answer);
  };

  const save = async (id: number) => {
    const next = draft.trim();
    if (!next) {
      toast.error('Answer cannot be empty');
      return;
    }
    setBusyId(id);
    try {
      const res = await fetch(`/api/apply/screening-answers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Save failed');
      toast.success('Answer updated — used from your next application onward');
      setEditingId(null);
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (a: Answer) => {
    setBusyId(a.id);
    try {
      const res = await fetch(`/api/apply/screening-answers/${a.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Delete failed');
      toast.success('Forgotten — this question will be answered fresh next time');
      mutate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquareText className="h-4 w-4" /> Screening answers
        </CardTitle>
        <CardDescription>
          Answers auto-apply saved and reuses whenever a portal asks the same question. Edit one to
          correct it everywhere, or delete it to be asked fresh next time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}

        {!isLoading && answers.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing saved yet. Answers appear here after your first auto-apply that hits a screening
            question.
          </p>
        )}

        {answers.map((a) => {
          const editing = editingId === a.id;
          const busy = busyId === a.id;
          return (
            <div key={a.id} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium leading-snug">{a.question}</p>
                <div className="flex shrink-0 items-center gap-1">
                  {a.category && (
                    <Badge variant={CATEGORY_TONE[a.category] ?? 'muted'} className="text-[10px]">
                      {a.category.replace(/_/g, ' ')}
                    </Badge>
                  )}
                  <Badge
                    variant="muted"
                    className="text-[10px]"
                    title="How many applications reused this answer"
                  >
                    ×{a.used_count}
                  </Badge>
                </div>
              </div>

              {editing ? (
                <div className="space-y-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={() => save(a.id)} disabled={busy}>
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} disabled={busy}>
                      <X className="h-3.5 w-3.5" /> Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{a.answer}</p>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => startEdit(a)}
                      disabled={busy}
                      title="Edit this answer"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      onClick={() => remove(a)}
                      disabled={busy}
                      title="Forget this answer"
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
