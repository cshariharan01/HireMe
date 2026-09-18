'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send, AlertTriangle, CheckCircle2, FileText, Wand2, Globe, Eye, EyeOff, ExternalLink, Check, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { CoverLetterView } from '@/components/cover-letter-view';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { revalidateApplications, revalidateMatches, revalidateDigest, revalidateDashboardStats } from '@/lib/hooks';

interface FieldValueOption {
  label: string;
  value: number | string;
}
interface AttachmentMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}
interface PlannedField {
  name: string;
  type: string;
  label: string;
  required: boolean;
  value: string | FieldValueOption | AttachmentMeta | null;
  warning?: string;
  source?: string;
  category?: string;
}
interface Plan {
  strategy: 'greenhouse' | 'ashby' | 'browser' | 'manual' | 'linkedin' | 'naukri' | string;
  slug?: string;
  jobId?: string;
  jobTitle: string;
  company: string;
  url?: string;
  fields: PlannedField[];
  attachments: {
    resume: AttachmentMeta | null;
    coverLetter: AttachmentMeta | null;
  };
}
interface PreviewResponse {
  ok: boolean;
  alreadyApplied?: boolean;
  appliedDate?: string;
  strategy: string;
  plan?: Plan;
  coverLetterMarkdown?: string | null;
  warnings?: Array<{ code: string; message: string }>;
  error?: string;
  resumeSource?: 'original' | 'tailored';
  resumeSourceAvailable?: { original: boolean };
  tailoredReady?: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}

function fieldDisplayValue(f: PlannedField): string {
  if (f.value === null || f.value === undefined) return '';
  if (typeof f.value === 'string') return f.value;
  if (typeof f.value === 'object' && 'label' in f.value) return (f.value as FieldValueOption).label;
  if (typeof f.value === 'object' && 'filename' in f.value) return (f.value as AttachmentMeta).filename;
  return String(f.value);
}

export function AutoApplyDialog({
  jobId,
  open,
  onOpenChange,
  onSubmitted,
}: {
  jobId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmitted?: () => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(true);
  const [submitResult, setSubmitResult] = useState<{
    ok: boolean;
    unconfirmed?: boolean;
    stoppedForReview?: boolean;
    readyForSubmit?: boolean;
    alreadyApplied?: boolean;
    dryRun?: boolean;
    error?: string;
    submissionId?: string;
    response?: {
      readyForSubmit?: boolean;
      platformStatus?: string;
    };
  } | null>(null);
  const [resumeSource, setResumeSource] = useState<'original' | 'tailored' | null>(null); // null = server default
  const [showCoverLetter, setShowCoverLetter] = useState(false);
  const [coverLetterBusy, setCoverLetterBusy] = useState(false);
  const [markingApplied, setMarkingApplied] = useState(false);

  const activeResumeSource = resumeSource ?? preview?.resumeSource ?? 'original';
  const originalAvailable = preview?.resumeSourceAvailable?.original ?? false;

  const handleMarkApplied = async () => {
    setMarkingApplied(true);
    try {
      const res = await fetch('/api/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, status: 'applied', resume_source: activeResumeSource }),
      });
      if (!res.ok) throw new Error();
      toast.success('Application marked as applied and moved to Tracker!');
      revalidateApplications();
      revalidateMatches();
      revalidateDigest();
      if (onSubmitted) onSubmitted();
      onOpenChange(false);
      router.push('/tracker');
    } catch {
      toast.error('Failed to update tracker status');
    } finally {
      setMarkingApplied(false);
    }
  };

  const [regeneratingResume, setRegeneratingResume] = useState(false);

  /** Fetch the submission preview. Shared by the open effect and the cover-letter button. */
  const loadPreview = useCallback(async (opts?: { forceRegenerate?: boolean }) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (resumeSource) params.set('resume', resumeSource);
    if (opts?.forceRegenerate) params.set('regenerate', 'true');
    const q = params.toString() ? `?${params.toString()}` : '';
    try {
      const r = await fetch(`/api/jobs/${jobId}/apply${q}`);
      setPreview((await r.json()) as PreviewResponse);
    } catch (e) {
      setPreview({ ok: false, strategy: 'unknown', error: e instanceof Error ? e.message : 'Preview failed' });
    } finally {
      setLoading(false);
    }
  }, [jobId, resumeSource]);

  const regenerateTailoredResume = async () => {
    setRegeneratingResume(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/resume.pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'tailored', regenerate: true }),
      });
      if (!res.ok) throw new Error(`Regeneration failed (HTTP ${res.status})`);
      await loadPreview({ forceRegenerate: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to regenerate tailored résumé');
    } finally {
      setRegeneratingResume(false);
    }
  };

  const [tailoringInProgress, setTailoringInProgress] = useState(false);

  const prepareTailoredNow = useCallback(async () => {
    if (tailoringInProgress) return;
    setTailoringInProgress(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/resume.pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'tailored' }),
      });
      if (!res.ok) throw new Error(`Preparation failed (${res.status})`);
      await loadPreview();
      toast.success('Tailored résumé prepared');
    } catch (e) {
      console.warn('Tailored resume prep error:', e);
    } finally {
      setTailoringInProgress(false);
    }
  }, [jobId, loadPreview, tailoringInProgress]);

  /**
   * Generate a cover letter for this job, then reload the preview so it shows as an attachment.
   * Can take a while on a free provider — that is exactly why it is not done automatically.
   */
  const generateCoverLetterNow = async () => {
    setCoverLetterBusy(true);
    try {
      const r = await fetch('/api/generate/cover-letter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not write a cover letter');
      toast.success('Cover letter ready');
      await loadPreview();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Cover letter failed');
    } finally {
      setCoverLetterBusy(false);
    }
  };
  const [resumePdfLoading, setResumePdfLoading] = useState(false);

  const openResumePdf = async () => {
    // Open the new tab IMMEDIATELY inside the click handler — browsers block
    // window.open calls that happen after an async await because the user-gesture
    // context is lost. We point it at about:blank now and rewrite the URL once
    // the PDF is ready.
    const win = window.open('about:blank', '_blank');
    if (win) {
      // Never leave the user staring at a blank tab. Generating a tailored résumé is an LLM call
      // plus a PDF render and can take a while; `about:blank` gives no clue that anything is
      // happening, which reads as "it opened a broken page".
      try {
        win.document.write(
          '<!doctype html><meta charset="utf-8"><title>Preparing your résumé…</title>' +
            '<style>body{font:15px system-ui,sans-serif;margin:0;height:100vh;display:flex;' +
            'align-items:center;justify-content:center;color:#57534e;background:#fafaf9}' +
            '@media(prefers-color-scheme:dark){body{background:#1c1917;color:#d6d3d1}}</style>' +
            '<div>Preparing your résumé…</div>',
        );
        win.document.close();
      } catch { /* cross-origin or blocked — the tab will just stay blank briefly */ }
    }
    if (!win) {
      // Popup blocked — fall back to inline download via anchor click
      toast('Popup blocked — saving instead');
    }
    setResumePdfLoading(true);
    try {
      // Send the source the user actually picked. An empty body made the server ignore the
      // uploaded PDF and generate a fresh AI variant every time — an LLM call and a Playwright
      // render to show a document that already exists.
      const r = await fetch(`/api/jobs/${jobId}/resume.pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: resumeSource ?? preview?.resumeSource ?? 'original' }),
      });
      if (!r.ok) throw new Error(`PDF render failed (HTTP ${r.status})`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (win) {
        win.location.href = url;
      } else {
        // Anchor-click fallback when popups are blocked
        const a = document.createElement('a');
        a.href = url;
        a.download = 'resume.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      if (win) win.close();
      toast.error(e instanceof Error ? e.message : 'Failed to open PDF');
    } finally {
      setResumePdfLoading(false);
    }
  };

  // Load preview when opened (or when the resume source changes).
  useEffect(() => {
    if (!open) {
      // Reset on close
      setPreview(null);
      setOverrides({});
      setSubmitResult(null);
      setShowCoverLetter(false);
      setResumeSource(null);
      setTailoringInProgress(false);
      return;
    }
    void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jobId, resumeSource]);

  // Auto-prepare tailored résumé when preview opens if it is not yet tailored
  useEffect(() => {
    if (
      open &&
      preview?.ok &&
      activeResumeSource === 'tailored' &&
      preview.tailoredReady === false &&
      !tailoringInProgress
    ) {
      void prepareTailoredNow();
    }
  }, [open, preview?.ok, preview?.tailoredReady, activeResumeSource, tailoringInProgress, prepareTailoredNow]);

  const handleSubmit = useCallback(async () => {
    if (!preview?.plan) return;
    setSubmitting(true);
    setSubmitResult(null);
    toast.info(
      preview.strategy === 'browser'
        ? 'Opening Chrome to begin application...'
        : `Preparing application for ${preview.plan.company}...`,
      { duration: 3500 }
    );
    try {
      const url = `/api/jobs/${jobId}/apply${dryRun ? '?dry_run=1' : autoSubmit ? '?auto_submit=1' : ''}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overrides,
          resumeSource: resumeSource ?? undefined,
          autoSubmit,
        }),
      });
      const json = await res.json();
      setSubmitResult(json);

      const isAlreadyApplied = Boolean(
        json.alreadyApplied ||
        json.response?.platformStatus === 'already_applied' ||
        json.error?.toLowerCase().includes('already applied')
      );
      const isSubmitted = Boolean(
        json.response?.submitted ||
        (json.ok && !json.stoppedForReview)
      );

      if (json.stoppedForReview) {
        toast.success('Form filled! Switch to the Chrome window to review & submit', { duration: 6000 });
        void fetch('/api/apply/focus-browser', { method: 'POST' }).catch(() => {});
        revalidateApplications();
        revalidateMatches();
        revalidateDashboardStats();
        revalidateDigest();
        if (!dryRun && onSubmitted) onSubmitted();
      } else if (isAlreadyApplied) {
        toast.info('Already applied on platform! Moved to Tracker.');
        revalidateApplications();
        revalidateMatches();
        revalidateDashboardStats();
        revalidateDigest();
        if (!dryRun && onSubmitted) onSubmitted();

        setTimeout(() => {
          onOpenChange(false);
          if (typeof window !== 'undefined' && window.location.pathname.startsWith('/job/')) {
            router.push('/');
          }
        }, 1200);
      } else if (isSubmitted) {
        const msg = dryRun
          ? 'Dry-run submitted (no real send)'
          : json.strategy === 'browser'
            ? 'Application submitted successfully! Redirecting to dashboard...'
            : `Applied via ${json.strategy}! Redirecting to dashboard...`;
        toast.success(msg);
        revalidateApplications();
        revalidateMatches();
        revalidateDashboardStats();
        revalidateDigest();
        if (!dryRun && onSubmitted) onSubmitted();

        // Redirect back to job dashboard internally without user screen interruption
        setTimeout(() => {
          onOpenChange(false);
          if (typeof window !== 'undefined' && window.location.pathname.startsWith('/job/')) {
            router.push('/');
          }
        }, 1200);
      } else if (json.ok) {
        toast.success('Form filled! Switch to the Chrome window to review & submit', { duration: 6000 });
        revalidateApplications();
        revalidateMatches();
        revalidateDashboardStats();
        revalidateDigest();
        if (!dryRun && onSubmitted) onSubmitted();
      } else if (json.unconfirmed) {
        // Fields were filled and application tracked — notify user
        toast.warning('Filled in — finish and Submit in the browser window');
        revalidateApplications();
        revalidateMatches();
        revalidateDashboardStats();
        revalidateDigest();
        if (!dryRun && onSubmitted) onSubmitted();
      } else if (json.response?.platformStatus === 'login_required' || json.error?.toLowerCase().includes('login')) {
        toast.warning('Please log into your account in the Chrome window that opened');
      } else {
        toast.error(json.error || 'Submission failed');
      }
    } catch (e: any) {
      setSubmitResult({ ok: false, error: e?.message || 'Submission request failed' });
      toast.error(`Submission failed: ${e?.message || 'Network error'}`);
    } finally {
      setSubmitting(false);
    }
  }, [preview, jobId, dryRun, autoSubmit, overrides, resumeSource, onSubmitted, onOpenChange, router]);

  // Auto-start submission progress stages when dialog opens in autoSubmit mode
  useEffect(() => {
    if (open && autoSubmit && preview?.ok && !submitting && !submitResult && !loading) {
      void handleSubmit();
    }
  }, [open, autoSubmit, preview?.ok, submitting, submitResult, loading, handleSubmit]);

  const relevantWarnings = useMemo(() => {
    return (preview?.warnings || []).filter(
      (w) =>
        w.code !== 'cover_letter_pending' &&
        w.code !== 'resume_variant_pending' &&
        !/cover\s*letter/i.test(w.message) &&
        !/tailored\s*version\s*is\s*generated/i.test(w.message)
    );
  }, [preview?.warnings]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <div className="space-y-1.5">
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            Auto-apply preview
          </DialogTitle>
          <DialogDescription>
            Review every field before submitting. Edit any value below — your edits override what we pre-filled.
          </DialogDescription>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Building submission plan…
          </div>
        )}

        {!loading && preview && !preview.ok && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm space-y-2">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Can&apos;t auto-apply
            </div>
            <p className="text-foreground/85">{preview.error}</p>
            <p className="text-xs text-muted-foreground">
              Detected strategy: <code className="font-mono">{preview.strategy}</code> — use &quot;Apply on company site&quot; manually for now.
            </p>
          </div>
        )}

        {!loading && preview?.ok && preview.plan && (
          <div className="space-y-4">
            {preview.alreadyApplied && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-medium">
                  <CheckCircle2 className="h-4 w-4" />
                  Applied Successfully {preview.appliedDate ? `(${preview.appliedDate})` : ''}
                </div>
                <Badge variant="success">In Tracker</Badge>
              </div>
            )}

            {/* Strategy badge + warnings */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info" className="font-mono">{preview.strategy}</Badge>
              <span className="text-sm text-muted-foreground">{preview.plan.jobTitle} · {preview.plan.company}</span>
            </div>

            {/* Browser / Platform hint: explain that a Chrome window will open */}
            {(preview.strategy === 'browser' || preview.strategy === 'linkedin' || preview.strategy === 'naukri') && (
              <div className="rounded-md border border-info/30 bg-info/5 p-3 text-sm space-y-1">
                <div className="flex items-center gap-2 font-medium text-info">
                  <Globe className="h-3.5 w-3.5" />
                  We&apos;ll open the application in Google Chrome
                </div>
                <p className="text-foreground/85 text-xs">
                  {preview.strategy === 'linkedin'
                    ? "We'll open Chrome, start the LinkedIn Easy Apply flow, pre-fill your answers, attach your tailored resume, and bring Chrome to the front so you can review before submitting."
                    : preview.strategy === 'naukri'
                    ? "We'll open Chrome, start the Naukri direct apply/chatbot flow, answer the questions, attach your tailored resume, and bring Chrome to the front so you can review before submitting."
                    : "We'll open Chrome, pre-fill the standard fields, and attach your resume + cover letter. You review and click Submit on the page itself."}
                </p>
              </div>
            )}

            {relevantWarnings.length > 0 && (
              <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs space-y-1">
                <div className="flex items-center gap-2 font-medium text-warning">
                  <AlertTriangle className="h-3 w-3" />
                  Warnings ({relevantWarnings.length})
                </div>
                {relevantWarnings.map((w, i) => (
                  <p key={i} className="text-foreground/85">· {w.message}</p>
                ))}
              </div>
            )}

            {/* Resume source toggle */}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">Résumé to send</p>
              <div className="space-y-1">
                <div className="inline-flex rounded-lg border p-0.5">
                  <button
                    onClick={() => setResumeSource('original')}
                    disabled={!originalAvailable}
                    className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40',
                      activeResumeSource === 'original' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    Original PDF
                  </button>
                  <button
                    onClick={() => setResumeSource('tailored')}
                    className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      activeResumeSource === 'tailored' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    AI-tailored
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {activeResumeSource === 'original'
                    ? 'Sends your real uploaded résumé, unchanged.'
                    : 'Sends an AI-rewritten résumé tailored to this job (ATS-keyword optimized).'}
                  {!originalAvailable && ' — Original unavailable; re-upload your résumé on Profile to enable it.'}
                </p>
              </div>
            </div>

            {/* Attachments */}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">Attachments</p>
              <div className="space-y-1.5">
                {preview.plan.attachments.resume && (
                  <div className="flex flex-wrap items-center gap-2 text-sm border rounded-md px-3 py-2 bg-muted/30">
                    <FileText className="h-3.5 w-3.5 text-info shrink-0" />
                    <span className="font-mono text-xs">{preview.plan.attachments.resume.filename}</span>
                    {activeResumeSource === 'tailored' ? (
                      tailoringInProgress || (!preview.tailoredReady && loading) ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                          <Loader2 className="h-3 w-3 animate-spin" /> Preparing tailored résumé…
                        </span>
                      ) : preview.tailoredReady ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                          <Check className="h-3 w-3" /> Resume has been tailored
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={prepareTailoredNow}
                          className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
                        >
                          <Wand2 className="h-3 w-3" /> Prepare tailored résumé
                        </button>
                      )
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/30 bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        Original Resume
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto tabular">{formatBytes(preview.plan.attachments.resume.sizeBytes)}</span>
                    <button
                      type="button"
                      onClick={openResumePdf}
                      disabled={resumePdfLoading || regeneratingResume || tailoringInProgress}
                      className="inline-flex items-center gap-1 text-xs text-info hover:underline disabled:opacity-60"
                      title="Open PDF in new tab"
                    >
                      {resumePdfLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                      View
                    </button>
                    {activeResumeSource === 'tailored' && (
                      <button
                        type="button"
                        onClick={regenerateTailoredResume}
                        disabled={resumePdfLoading || regeneratingResume || tailoringInProgress}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-60 ml-1"
                        title="Regenerate tailored résumé"
                      >
                        {regeneratingResume ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        Regenerate
                      </button>
                    )}
                  </div>
                )}
                {/* No cover letter yet — offer to write one ON DEMAND.
                    The preview deliberately does not generate it: doing that inline made opening
                    this dialog take up to 277s. Making it an explicit button keeps the dialog
                    instant AND keeps the feature — you decide when to spend the time. */}
                {!preview.plan.attachments.coverLetter && (
                  <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-sm">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">No cover letter attached</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7"
                      disabled={coverLetterBusy}
                      onClick={generateCoverLetterNow}
                    >
                      {coverLetterBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                      {coverLetterBusy ? 'Writing…' : 'Write one'}
                    </Button>
                  </div>
                )}
                {preview.plan.attachments.coverLetter && (
                  <div className="border rounded-md bg-muted/30">
                    <div className="flex items-center gap-2 text-sm px-3 py-2">
                      <FileText className="h-3.5 w-3.5 text-info" />
                      <span className="font-mono">{preview.plan.attachments.coverLetter.filename}</span>
                      <span className="text-xs text-muted-foreground ml-auto">{formatBytes(preview.plan.attachments.coverLetter.sizeBytes)}</span>
                      {preview.coverLetterMarkdown && (
                        <button
                          type="button"
                          onClick={() => setShowCoverLetter((v) => !v)}
                          className="inline-flex items-center gap-1 text-xs text-info hover:underline"
                        >
                          {showCoverLetter ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                          {showCoverLetter ? 'Hide' : 'View'}
                        </button>
                      )}
                    </div>
                    {showCoverLetter && preview.coverLetterMarkdown && (
                      <div className="border-t bg-background px-3 py-3 max-h-[420px] overflow-y-auto">
                        <CoverLetterView
                          markdown={preview.coverLetterMarkdown}
                          company={preview.plan.company}
                          jobTitle={preview.plan.jobTitle}
                        />
                      </div>
                    )}
                  </div>
                )}
                {!preview.plan.attachments.resume && !preview.plan.attachments.coverLetter && (
                  <p className="text-xs text-muted-foreground italic">No attachments — generate cover-letter and resume-variant first.</p>
                )}
              </div>
            </div>

            <Separator />

            {/* Fields */}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
                Form fields ({preview.plan.fields.length})
              </p>
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                {preview.plan.fields
                  // Hide file fields (shown in Attachments) AND hide the cover-letter form-field
                  // (we already show its content in the Attachments "View" toggle — duplicate UI).
                  .filter((f) => f.type !== 'input_file' && f.type !== 'File' && f.name !== 'cover_letter')
                  .map((f, i) => {
                  const displayVal = fieldDisplayValue(f);
                  // Multi-line OR explicit textarea/RichText/LongText → render as textarea
                  const isMultiline = f.type === 'textarea' || f.type === 'LongText' || f.type === 'RichText' || /\n/.test(displayVal);
                  return (
                  <div key={f.name + i} className={cn(
                    'rounded-md border p-2.5 text-sm',
                    f.warning && 'border-warning/50 bg-warning/5',
                    !f.value && f.required && 'border-destructive/50 bg-destructive/5',
                  )}>
                    <div className="flex items-baseline justify-between gap-2">
                      <label className="text-xs font-medium text-foreground/90 flex-1 min-w-0">
                        {f.label}
                        {f.required && <span className="text-destructive ml-1">*</span>}
                      </label>
                      <div className="flex items-center gap-1">
                        {f.source && <Badge variant="outline" className="text-[9px] px-1 py-0">{f.source}</Badge>}
                        {f.category && f.category !== 'other' && (
                          <Badge variant="muted" className="text-[9px] px-1 py-0">{f.category}</Badge>
                        )}
                      </div>
                    </div>
                    {f.warning && (
                      <p className="text-[11px] text-warning mt-0.5">⚠ {f.warning}</p>
                    )}
                    {isMultiline ? (
                      <textarea
                        defaultValue={displayVal}
                        placeholder={f.required ? 'required — fill manually' : 'optional'}
                        rows={Math.min(8, Math.max(3, displayVal.split('\n').length))}
                        onChange={(e) => setOverrides({ ...overrides, [f.name]: e.target.value })}
                        className="mt-1.5 w-full rounded-md border border-input bg-card text-foreground font-semibold px-2.5 py-1.5 text-sm font-mono placeholder:text-muted-foreground placeholder:font-normal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y shadow-xs"
                      />
                    ) : (
                      <input
                        type="text"
                        defaultValue={displayVal}
                        placeholder={f.required ? 'required — fill manually' : 'optional'}
                        onChange={(e) => setOverrides({ ...overrides, [f.name]: e.target.value })}
                        className="mt-1.5 w-full rounded-md border border-input bg-card text-foreground font-semibold px-2.5 py-1.5 text-sm font-mono placeholder:text-muted-foreground placeholder:font-normal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shadow-xs"
                      />
                    )}
                  </div>
                  );
                })}
              </div>
            </div>

            {/* Submit */}
            <Separator />

            {submitResult && (
              <div className={cn(
                'rounded-md border p-3 text-sm space-y-2',
                submitResult.stoppedForReview
                  ? 'border-info/30 bg-info/10'
                  : submitResult.ok
                    ? 'border-success/30 bg-success/10'
                    : submitResult.unconfirmed
                      ? 'border-warning/30 bg-warning/10'
                      : 'border-destructive/30 bg-destructive/10',
              )}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-medium">
                    {submitResult.stoppedForReview ? (
                      <CheckCircle2 className="h-4 w-4 text-info" />
                    ) : submitResult.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : (
                      <AlertTriangle className={cn('h-4 w-4', (submitResult.unconfirmed || submitResult.error?.toLowerCase().includes('login')) ? 'text-warning' : 'text-destructive')} />
                    )}
                    <span>
                      {submitResult.stoppedForReview
                        ? (submitResult.readyForSubmit || submitResult.response?.readyForSubmit)
                          ? 'Ready for Submit'
                          : 'Ready for review'
                        : submitResult.alreadyApplied || submitResult.response?.platformStatus === 'already_applied'
                          ? 'Already applied on platform'
                          : submitResult.ok
                            ? submitResult.dryRun ? 'Dry-run completed' : 'Application submitted successfully! Redirecting to dashboard...'
                            : submitResult.error?.toLowerCase().includes('login')
                              ? 'Login required in Chrome'
                              : submitResult.unconfirmed
                                ? 'Filled in — confirmation not detected'
                                : 'Submission failed'}
                    </span>
                  </div>
                  {submitResult.stoppedForReview && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-7 text-xs gap-1.5 font-medium"
                      onClick={async () => {
                        try {
                          await fetch('/api/apply/focus-browser', { method: 'POST' });
                          toast.success('Brought Chrome window to front');
                        } catch { /* ignore */ }
                      }}
                    >
                      <Globe className="h-3.5 w-3.5" />
                      Bring Chrome to Front
                    </Button>
                  )}
                </div>
                {submitResult.submissionId && (
                  <p className="text-xs text-muted-foreground">Submission ID: <code className="font-mono">{submitResult.submissionId}</code></p>
                )}
                {submitResult.error && <p className="text-xs text-foreground/85">{submitResult.error}</p>}
                
                {/* 1-click Move to Tracker action */}
                {(submitResult.stoppedForReview || submitResult.readyForSubmit || submitResult.ok || submitResult.unconfirmed || submitResult.alreadyApplied) && !dryRun && (
                  <div className="pt-2 mt-2 flex items-center justify-between gap-2 border-t border-border/50">
                    <p className="text-xs text-muted-foreground">
                      {submitResult.stoppedForReview ? 'Submitted in Chrome? Move to Tracker:' : 'Track this application:'}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      className="h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-sm"
                      disabled={markingApplied}
                      onClick={handleMarkApplied}
                    >
                      {markingApplied ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Mark as Applied & Move to Tracker
                    </Button>
                  </div>
                )}

                {!submitResult.stoppedForReview && preview.plan.url && (
                  <div className="pt-1">
                    <a
                      href={preview.plan.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-info hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open job in your browser
                    </a>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-2">
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoSubmit}
                    onChange={(e) => setAutoSubmit(e.target.checked)}
                    className="h-3 w-3 accent-info"
                  />
                  Auto-submit on completion
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                    className="h-3 w-3 accent-info"
                  />
                  Dry-run (log payload, don&apos;t send)
                </label>
              </div>
              <div className="flex items-center gap-2">
                {preview.plan.url && (
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="h-8 text-xs gap-1.5"
                  >
                    <a href={preview.plan.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open in browser
                    </a>
                  </Button>
                )}
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={submitting || !preview.plan.attachments.resume || preview.alreadyApplied}
                  variant={dryRun ? 'outline' : 'default'}
                >
                  {submitting
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : preview.alreadyApplied
                      ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      : preview.strategy === 'browser' && !dryRun
                        ? <Globe className="h-3.5 w-3.5" />
                        : <Send className="h-3.5 w-3.5" />}
                  {preview.alreadyApplied
                    ? 'Already applied'
                    : dryRun
                      ? 'Dry-run submit'
                      : preview.strategy === 'browser'
                        ? 'Open browser to apply'
                        : preview.strategy === 'linkedin'
                          ? 'Open LinkedIn & fill'
                          : preview.strategy === 'naukri'
                            ? 'Open Naukri & fill'
                            : 'Confirm & submit'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
