'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import ReactMarkdown from 'react-markdown';
import { useJobDetail, revalidateApplications, revalidateMatches, revalidateDigest, revalidateDashboardStats } from '@/lib/hooks';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  FileSignature,
  Copy,
  Check,
  CheckCircle2,
  Loader2,
  Sparkles,
  MapPin,
  Target,
  TrendingUp,
  Save,
  Download,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  CircleHelp,
  ScrollText,
  ShieldCheck,
  Banknote,
  Building,
  Briefcase as BriefcaseIcon,
  Activity,
  Users,
  HelpCircle,
  Link as LinkIcon,
  Wand2,
  Clock,
  Trash2,
} from 'lucide-react';
import { AutoApplyDialog } from '@/components/auto-apply-dialog';
import { CoverLetterView } from '@/components/cover-letter-view';
// Pure URL regex — no server dependencies — so the client can decide what to OFFER before the user
// clicks, instead of finding out after a live URL check and a spinner.
import { identifySubmissionStrategy, strategyActionLabel, submitsDirectly } from '@/lib/apply/router';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ScoreBadge } from '@/components/ui/score-badge';
import { cn, formatJobAge } from '@/lib/utils';
import { toast } from 'sonner';
import { downloadBlob } from '@/lib/download-blob';

interface GapAnalysis {
  matchedSkills: string[];
  missingKeywords: string[];
}

interface JobDetail {
  job: {
    id: number;
    source: string;
    company: string;
    title: string;
    location: string;
    description: string;
    descriptionFormatted: string | null;
    url: string;
    domainPriority: number;
  };
  match: {
    ontologyBoost: number;
    finalScore: number;
    /** Bounded 0-100 fit score (see src/lib/relevance.ts). */
    score?: number;
    /** "Why matched" chips, negatives first. */
    reasons?: Array<{ kind: string; label: string; tone: 'good' | 'bad' | 'neutral' }>;
    skillFit?: { required: string[]; matched: string[]; missing: string[]; missingInTitle: string[]; score: number };
    ageDays?: number | null;
    variants?: Array<{ id: number; location: string }>;
    gapAnalysis: GapAnalysis;
  } | null;
  application: {
    status: string;
    cover_letter: string;
    resume_variant: string;
    notes: string;
    applied_date?: string | null;
    recruiter_name?: string | null;
    recruiter_contact?: string | null;
    next_follow_up_at?: string | null;
  } | null;
}

const STATUS_OPTIONS: Array<{ key: string; label: string; dotClass: string }> = [
  { key: 'applied', label: 'Applied', dotClass: 'bg-info' },
  { key: 'screening', label: 'Screening', dotClass: 'bg-warning' },
  { key: 'interview', label: 'Interview', dotClass: 'bg-primary' },
  { key: 'offer', label: 'Offer', dotClass: 'bg-success' },
  { key: 'rejected', label: 'Rejected', dotClass: 'bg-destructive' },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="h-7"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function DownloadDocxButton({ markdown, fileName }: { markdown: string; fileName: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        setBusy(true);
        try {
          // Loaded on CLICK, not on import. `docx` is ~6MB installed and was statically imported
          // here, so every visitor to the dashboard downloaded the whole library's bundled weight
          // in the route's first-load JS just in case they wanted a .docx. Almost nobody clicks
          // this; those who do wait a few hundred ms once.
          const { markdownToDocxBlob } = await import('@/lib/markdown-to-docx');
          const blob = await markdownToDocxBlob(markdown, fileName);
          downloadBlob(blob, `${fileName}.docx`);
          toast.success('Downloaded .docx');
        } catch (e) {
          toast.error('Download failed');
          console.error(e);
        } finally {
          setBusy(false);
        }
      }}
      className="h-7"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      .docx
    </Button>
  );
}

function DownloadPdfButton({ markdown, jobId, fileName }: { markdown: string; jobId: string; fileName: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="default"
      size="sm"
      onClick={async () => {
        setBusy(true);
        try {
          // `{source:'tailored'}` (NOT `{markdown}`) so the server's LaTeX-preferred lane is used:
          // the resume.pdf route renders the stored resume_variant (or resume_tex) and compiles the
          // user's own LaTeX TEMPLATE when a compiler is available. An explicit `markdown` body
          // short-circuits straight to the plain ATS template renderer and bypasses LaTeX entirely —
          // that is the path that made the review PDF ignore the uploaded Overleaf design.
          const res = await fetch(`/api/jobs/${jobId}/resume.pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'tailored' }),
          });
          if (!res.ok) throw new Error('pdf generation failed');
          const blob = await res.blob();
          downloadBlob(blob, `${fileName}.pdf`);
          toast.success('Downloaded PDF (LaTeX template when available)');
        } catch (e) {
          toast.error('PDF generation failed');
          console.error(e);
        } finally {
          setBusy(false);
        }
      }}
      className="h-7"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      .pdf
    </Button>
  );
}

// JD-keyword coverage badge — shown after a generation runs. Visualizes how many of
// the JD's top keywords landed in the output, plus the misses so the user knows what
// to add manually if they care.
function KeywordCoverageBadge({ coverage }: { coverage: { required: string[]; matched: string[]; missing: string[] } }) {
  const total = coverage.required.length;
  if (total === 0) return null;
  const matched = coverage.matched.length;
  const pct = total > 0 ? matched / total : 0;
  const tone =
    pct >= 0.8 ? 'bg-success/15 text-success border-success/30'
    : pct >= 0.55 ? 'bg-warning/15 text-warning border-warning/30'
    : 'bg-destructive/15 text-destructive border-destructive/30';
  return (
    <div className="px-3 pt-2 pb-1 text-[11px]">
      <div className="flex items-center gap-2">
        <span className={cn('rounded-md border px-1.5 py-0.5 font-mono font-semibold tabular', tone)}>
          JD match: {matched}/{total}
        </span>
        {coverage.missing.length > 0 && (
          <span className="text-muted-foreground truncate">
            missing: {coverage.missing.join(', ')}
          </span>
        )}
      </div>
    </div>
  );
}

// Format a 1-5 score defensively — cached rows (esp. older LLM-parsed briefs) can carry null
// scores, and calling .toFixed on null throws and blanks the whole pane. '—' when unavailable.
function fmtScore(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : '—';
}

// A cached/partial brief can arrive with missing array fields (older rows, or an LLM response
// that dropped a key). Guarantee the four list fields are arrays so the render never calls
// .length / .map on undefined and crashes the whole pane.
function withBriefArrays<T extends Record<string, unknown>>(b: T): T {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    ...b,
    positive_themes: arr(b.positive_themes),
    concerns: arr(b.concerns),
    questions_for_recruiter: arr(b.questions_for_recruiter),
    evidence_sources: arr(b.evidence_sources),
  } as T;
}

function DimensionPanel({
  icon: Icon,
  label,
  score,
  notes,
}: {
  icon: typeof Target;
  label: string;
  score: number | null | undefined;
  notes: string;
}) {
  const s = typeof score === 'number' && Number.isFinite(score) ? score : null;
  const tone =
    s === null ? 'border-border bg-muted/30'
    : s >= 4 ? 'border-success/30 bg-success/5'
    : s >= 3 ? 'border-warning/30 bg-warning/5'
    : 'border-destructive/30 bg-destructive/5';
  const scoreColor =
    s === null ? 'text-muted-foreground'
    : s >= 4 ? 'text-success'
    : s >= 3 ? 'text-warning'
    : 'text-destructive';
  return (
    <div className={cn('rounded-md border p-3', tone)}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Icon className="h-3 w-3" />
          {label}
        </div>
        <span className={cn('font-mono text-sm font-semibold tabular', scoreColor)}>
          {fmtScore(s)}
        </span>
      </div>
      <p className="text-xs text-foreground/85 leading-relaxed">{notes}</p>
    </div>
  );
}

// Tailwind-styled Markdown components — renders the resume/cover-letter Markdown with proper hierarchy.
const MD_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-2xl font-bold tracking-tight text-center mb-1">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground mt-4 mb-2 border-b pb-1">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-base font-semibold mt-3 mb-1">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => <p className="text-sm text-foreground/90 mb-2 leading-relaxed">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-5 space-y-1 mb-2">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-5 space-y-1 mb-2">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="text-sm text-foreground/90 leading-relaxed">{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic text-muted-foreground">{children}</em>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} className="text-info hover:underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export function formatJobDescription(raw: string): string {
  if (!raw) return '';
  let text = raw;

  // Replace HTML breaks/paragraphs/lists if present
  text = text.replace(/<br\s*[\/]?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n');
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<[^>]+>/g, ' ');

  // Separate inline subheaders like "GCP Services:", "Programming:", "Data Concepts:", "Key Responsibilities:"
  text = text.replace(/([^\n])\s*(Key Responsibilities|Responsibilities|Requirements|Job Requirements\*?|Core Skills|Technical Skills|Qualifications|Basic Qualifications|Preferred Qualifications|Education|Experience|Benefits|What We Offer|GCP Services|Programming|Data Concepts|Tools|Location|Overall Exp):/g, '$1\n\n### $2:\n');

  // Handle common clumped metadata like "Location-Pan India" or "Overall Exp-5+"
  text = text.replace(/(Location-[^\s]+)/g, '\n\n**$1**\n');
  text = text.replace(/(Overall Exp-[^\s]+)/g, '\n\n**$1**\n');
  text = text.replace(/([a-z0-9\.\)])([A-Z][a-zA-Z\s]{2,25}:)/g, '$1\n\n**$2**\n');

  // Break bullet points onto separate lines
  text = text.replace(/([^\n])\s*([•·\*\-]\s+)/g, '$1\n- ');
  text = text.replace(/^([•·\*]\s+)/gm, '- ');

  // Clean up excess whitespace
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// Fetcher for the JD format endpoint (POST). SWR-cacheable and dedupes.
const formatFetcher = async (url: string) => {
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error('format failed');
  const { formatted } = await res.json();
  return formatted as string;
};

// Exported so the two-pane Matches screen can render the same detail body inline.
// variant 'page' = standalone route (shows back + prev/next bar, centered max-width);
// variant 'pane' = embedded in the Matches right pane (no top bar, fills width).
// Tabs for the detail view. The job description is in the DEFAULT tab, because reading it is the
// one thing you always want and it used to be section 12 of 12 — behind three cards that render
// "nothing here yet" placeholders plus a ~90-line tracking form, and clamped to 18rem.
const DETAIL_TABS = [
  { key: 'overview', label: 'Description' },
  { key: 'ai', label: 'AI review' },
  { key: 'company', label: 'Company' },
  { key: 'apply', label: 'Apply & track' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['key'];

export function JobDetailPanel({
  jobId: jobIdProp,
  variant = 'page',
  autoOpenApply = false,
  onAutoApplyNext,
  onHide,
  onApplied,
}: {
  jobId: string | number | undefined;
  variant?: 'page' | 'pane';
  autoOpenApply?: boolean;
  onAutoApplyNext?: () => void;
  onHide?: (jobId: number) => void;
  onApplied?: (jobId: number) => void;
}) {
  const router = useRouter();
  const jobId = jobIdProp != null && jobIdProp !== '' ? String(jobIdProp) : undefined;

  // Sibling navigation — read the visible match-IDs the dashboard wrote to sessionStorage,
  // so Prev/Next walks through the user's currently-filtered context, not arbitrary IDs.
  const siblings = useMemo<number[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = sessionStorage.getItem('hs:visibleMatchIds');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((n) => typeof n === 'number') : [];
    } catch {
      return [];
    }
  }, [jobId]);

  const currentIdx = jobId ? siblings.indexOf(Number(jobId)) : -1;
  const prevId = currentIdx > 0 ? siblings[currentIdx - 1] : null;
  const nextId = currentIdx >= 0 && currentIdx < siblings.length - 1 ? siblings[currentIdx + 1] : null;

  const goPrev = () => prevId !== null && router.push(`/job/${prevId}`);
  const goNext = () => nextId !== null && router.push(`/job/${nextId}`);

  // Hotkeys: [ → previous, ] → next. Skip when typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[' && prevId !== null) { e.preventDefault(); router.push(`/job/${prevId}`); }
      if (e.key === ']' && nextId !== null) { e.preventDefault(); router.push(`/job/${nextId}`); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prevId, nextId, router]);

  const { data, isLoading } = useJobDetail(jobId);
  const [coverLetter, setCoverLetter] = useState<string | null>(null);
  const [resumeVariant, setResumeVariant] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  // Fit score recomputed against the AI-tailored résumé (see /api/jobs/[id]/tailored-score).
  const [tailoredScore, setTailoredScore] = useState<{
    score: number;
    defaultScore: number | null;
    delta: number | null;
  } | null>(null);
  const [tailoredScoreLoading, setTailoredScoreLoading] = useState(false);
  const [status, setStatus] = useState('applied');
  const [notes, setNotes] = useState('');
  const [recruiterName, setRecruiterName] = useState('');
  const [recruiterContact, setRecruiterContact] = useState('');
  const [nextFollowUp, setNextFollowUp] = useState('');
  const [saved, setSaved] = useState(false);
  const [evaluation, setEvaluation] = useState<{
    overall_score: number;
    recommendation: string;
    cv_alignment_score: number;
    cv_alignment_notes: string;
    north_star_fit_score: number;
    north_star_fit_notes: string;
    compensation_score: number;
    compensation_notes: string;
    culture_score: number;
    culture_notes: string;
    strategy_notes: string;
  } | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  // Guards the auto-load (cache-only) evaluation so a cache-miss doesn't re-fire in a loop.
  // Explicit "Run now" / "Re-evaluate" bypass this. Reset per job below.
  const [evalTried, setEvalTried] = useState(false);
  const [companyBrief, setCompanyBrief] = useState<{
    display_name?: string;
    financial_health_score: number;
    financial_health_summary: string;
    funding_summary: string;
    layoffs_summary: string;
    growth_signal: string;
    culture_score: number;
    culture_summary: string;
    positive_themes: string[];
    concerns: string[];
    retention_signal: string;
    comp_summary: string;
    legitimacy_score: number;
    legitimacy_notes: string;
    overall_score: number;
    recommendation: 'apply' | 'hold' | 'pass';
    questions_for_recruiter: string[];
    evidence_sources: Array<{ label: string; url: string }>;
  } | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  // Same as evalTried: guards the auto-load (cache-only) company brief against a cache-miss loop.
  const [briefTried, setBriefTried] = useState(false);
  const [tab, setTab] = useState<DetailTab>('overview');
  // Expanded by DEFAULT now that the description is the landing tab — the 18rem clamp meant
  // reading it needed a click on top of the scroll.
  const [jdExpanded, setJdExpanded] = useState(true);
  // SEPARATE from jdExpanded, deliberately. These used to be the same flag, so expanding the
  // description also triggered the LLM formatting call. With the JD expanded by default that
  // would fire an LLM call on every job open — exactly the "on-load LLM storm" that the
  // cacheOnly work removed. Formatting is now an explicit action.
  const [jdFormatRequested, setJdFormatRequested] = useState(false);
  const [autoApplyOpen, setAutoApplyOpen] = useState(false);
  useEffect(() => {
    if (autoOpenApply && jobId) {
      setAutoApplyOpen(true);
    }
  }, [autoOpenApply, jobId]);
  // Keyword coverage from the most recent cover-letter / resume-variant generation
  type Coverage = { required: string[]; matched: string[]; missing: string[] };
  const [coverLetterCoverage, setCoverLetterCoverage] = useState<Coverage | null>(null);
  const [resumeCoverage, setResumeCoverage] = useState<Coverage | null>(null);
  // Compensation data from Levels.fyi (lazy-on-view, cached server-side)
  type CompData = {
    companySlug: string;
    region: 'US' | 'IN';
    sourceUrl: string;
    currency: string;
    medianTotalUsd: number | null;
    sampleCount: number;
    jobFamilies: Array<{
      name: string;
      slug: string;
      breakdown?: Array<{ level: string; total: number; count: number }>;
      titles?: Array<{ title: string; total: number; count: number }>;
    }>;
  };
  type RoleMatch = {
    jobFamily: string;
    level?: string;
    totalAtLevel?: number;
    totalForFamily?: number;
    sampleCount: number;
    matchSource: 'level' | 'family' | 'title' | 'none';
  };
  const [compData, setCompData] = useState<CompData | null>(null);
  const [compRoleMatch, setCompRoleMatch] = useState<RoleMatch | null>(null);
  const [compLoading, setCompLoading] = useState(false);
  const [compRegion, setCompRegion] = useState<'US' | 'IN'>('IN'); // Default India for an India-based user
  const [compTried, setCompTried] = useState(false);
  // Layoffs.fyi data (bulk-ingested, instant SQL lookup)
  type LayoffEvent = {
    layoff_date: string | null;
    laid_off_count: number | null;
    laid_off_pct: number | null;
    stage: string | null;
    source_url: string | null;
  };
  type LayoffSummary = {
    events: LayoffEvent[];
    totalEvents: number;
    totalLaidOff: number;
    mostRecentDate: string | null;
    riskFlag: 'none' | 'low' | 'moderate' | 'high';
    riskNote: string;
  };
  const [layoffs, setLayoffs] = useState<LayoffSummary | null>(null);
  const [layoffsTried, setLayoffsTried] = useState(false);
  // Ambitionbox (Indian-side ratings + salaries)
  type AbRatings = {
    overall: number;
    compensationBenefits: number;
    skillDevelopment: number;
    companyCulture: number;
    workLife: number;
    workSatisfaction: number;
    careerGrowth: number;
    jobSecurity: number;
    totalReviews: number;
    industryRating: number | null;
    lastUpdatedAt: string | null;
  };
  type AbSalary = {
    jobTitle: string;
    minCtc: number;
    maxCtc: number;
    avgCtc: number;
    typicalMinCtc: number;
    typicalMaxCtc: number;
    minExperience: number;
    maxExperience: number;
    dataPoints: number;
  };
  type AbReview = { likes: string | null; dislikes: string | null; jobLocation: string | null };
  type AbData = {
    companySlug: string;
    companyName: string;
    hq: string | null;
    industry: string | null;
    employeeBand: string | null;
    followersCount: number;
    ratings: AbRatings;
    salaries: AbSalary[];
    reviewSamples: AbReview[];
    sourceUrl: string;
  };
  const [ambitionbox, setAmbitionbox] = useState<AbData | null>(null);
  const [ambitionboxRoleSalary, setAmbitionboxRoleSalary] = useState<AbSalary | null>(null);
  const [ambitionboxLoading, setAmbitionboxLoading] = useState(false);
  const [ambitionboxTried, setAmbitionboxTried] = useState(false);

  // Sync form state when the SWR data arrives or refreshes
  useEffect(() => {
    if (!data?.application) return;
    setStatus(data.application.status || 'applied');
    setNotes(data.application.notes || '');
    setCoverLetter(data.application.cover_letter || null);
    setResumeVariant(data.application.resume_variant || null);
    setRecruiterName(data.application.recruiter_name || '');
    setRecruiterContact(data.application.recruiter_contact || '');
    setNextFollowUp(data.application.next_follow_up_at || '');
  }, [data?.application]);

  // Reset per-job lazy state when the selected job changes (the two-pane reuses this component
  // instance, so without this the previous job's evaluation/brief/comp/etc. would linger — and
  // the cache-only auto-loads below would never re-run for the new job). Keyed on the LOADED
  // job id (not the prop) so it fires once the new job's data has actually arrived.
  useEffect(() => {
    setEvaluation(null); setEvalTried(false);
    setCompanyBrief(null); setBriefTried(false);
    setCompData(null); setCompRoleMatch(null); setCompTried(false);
    setAmbitionbox(null); setAmbitionboxRoleSalary(null); setAmbitionboxTried(false);
    setLayoffs(null); setLayoffsTried(false);
    setTab('overview');
    setJdExpanded(true);
    setJdFormatRequested(false);
    setTailoredScore(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.job?.id]);

  // Auto-load the cached LLM evaluation on view — cache-only, so opening a job NEVER triggers an
  // LLM call by itself. Uncached jobs show a "Run now" button (reEvaluate) that computes on click.
  useEffect(() => {
    if (!data?.job || evaluation || evalLoading || evalTried) return;
    setEvalTried(true);
    setEvalLoading(true);
    fetch(`/api/jobs/${jobId}/evaluate?cacheOnly=1`, { method: 'POST' })
      .then((r) => r.json())
      .then((res) => {
        if (res.evaluation) setEvaluation(res.evaluation);
      })
      .catch(() => { /* silent — user can Run now */ })
      .finally(() => setEvalLoading(false));
  }, [data?.job, jobId, evaluation, evalLoading, evalTried]);

  // Fetch Layoffs.fyi data — instant SQL lookup, no scraping at request time.
  // TAB-GATED: only fetch when the Company tab is actually open.
  //
  // These four effects used to fire on EVERY job click while the default tab is Description, so
  // opening a job cost four extra round trips for panels the user could not see. The tab guard
  // previously controlled RENDERING only — none of these effects looked at `tab`.
  //
  // Layoffs additionally gained the `tried` guard the others already had: a company with NO layoff
  // record leaves `layoffs` null, so the old condition stayed true and re-fetched on every render.
  useEffect(() => {
    if (tab !== 'company') return;
    if (!data?.job?.company || layoffs || layoffsTried) return;
    setLayoffsTried(true);
    const slug = data.job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    fetch(`/api/companies/${slug}/layoffs`)
      .then((r) => r.json())
      .then((res) => { if (res.summary) setLayoffs(res.summary); })
      .catch(() => { /* silent fail */ });
  }, [tab, data?.job, layoffs, layoffsTried]);

  // Lazy-load Ambitionbox — Indian-side ratings + salaries. Cached server-side per company.
  // TAB-GATED: only fetch when the Company tab is actually open.
  //
  // These four effects used to fire on EVERY job click while the default tab is Description, so
  // opening a job cost four extra round trips for panels the user could not see. The tab guard
  // previously controlled RENDERING only — none of these effects looked at `tab`.
  useEffect(() => {
    if (tab !== 'company') return;
    if (!data?.job?.company || ambitionboxTried || ambitionboxLoading) return;
    setAmbitionboxTried(true);
    setAmbitionboxLoading(true);
    const slug = data.job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    fetch(`/api/companies/${slug}/ambitionbox?cacheOnly=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role_hint: data.job.title }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.data) setAmbitionbox(res.data);
        if (res.roleSalary) setAmbitionboxRoleSalary(res.roleSalary);
      })
      .catch(() => { /* silent fail */ })
      .finally(() => setAmbitionboxLoading(false));
  }, [tab, data?.job, ambitionboxTried, ambitionboxLoading]);

  const refreshAmbitionbox = async () => {
    if (!data?.job?.company) return;
    setAmbitionboxLoading(true);
    const slug = data.job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    try {
      const res = await fetch(`/api/companies/${slug}/ambitionbox?refresh=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_hint: data.job.title }),
      });
      const json = await res.json();
      setAmbitionbox(json.data || null);
      setAmbitionboxRoleSalary(json.roleSalary || null);
      if (!json.data) toast(json.error || 'No Ambitionbox data');
      else toast.success('Ambitionbox refreshed');
    } catch {
      toast.error('Ambitionbox refresh failed');
    } finally {
      setAmbitionboxLoading(false);
    }
  };

  // Lazy-load Levels.fyi compensation — fires after job data arrives. Cached server-side
  // per (company, region). Skip on subsequent re-renders (compTried gate).
  // TAB-GATED: only fetch when the Company tab is actually open.
  //
  // These four effects used to fire on EVERY job click while the default tab is Description, so
  // opening a job cost four extra round trips for panels the user could not see. The tab guard
  // previously controlled RENDERING only — none of these effects looked at `tab`.
  useEffect(() => {
    if (tab !== 'company') return;
    if (!data?.job?.company || compTried || compLoading) return;
    setCompTried(true);
    setCompLoading(true);
    const slug = data.job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    fetch(`/api/companies/${slug}/compensation?region=${compRegion}&cacheOnly=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: data.job.company, role_hint: data.job.title }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.compensation) setCompData(res.compensation);
        if (res.roleMatch) setCompRoleMatch(res.roleMatch);
      })
      .catch(() => { /* silently fail; user can refresh */ })
      .finally(() => setCompLoading(false));
  }, [tab, data?.job, compTried, compLoading, compRegion]);

  const refreshComp = async (newRegion?: 'US' | 'IN') => {
    if (!data?.job?.company) return;
    const region = newRegion || compRegion;
    if (newRegion) setCompRegion(newRegion);
    setCompLoading(true);
    const slug = data.job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    try {
      const refreshFlag = newRegion ? '' : '&refresh=1'; // region change uses cache for that region
      const res = await fetch(`/api/companies/${slug}/compensation?region=${region}${refreshFlag}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: data.job.company, role_hint: data.job.title }),
      });
      const json = await res.json();
      setCompData(json.compensation || null);
      setCompRoleMatch(json.roleMatch || null);
      if (!json.compensation) toast(json.error || 'No comp data on Levels.fyi');
      else if (!newRegion) toast.success('Compensation refreshed');
    } catch {
      toast.error('Comp lookup failed');
    } finally {
      setCompLoading(false);
    }
  };

  // Auto-load the cached company brief on view — cache-only, so opening a job NEVER triggers the
  // LLM (+web search) by itself. Uncached companies show a "Run research now" button (refreshBrief).
  // TAB-GATED: only fetch when the Company tab is actually open.
  //
  // These four effects used to fire on EVERY job click while the default tab is Description, so
  // opening a job cost four extra round trips for panels the user could not see. The tab guard
  // previously controlled RENDERING only — none of these effects looked at `tab`.
  useEffect(() => {
    if (tab !== 'company') return;
    if (!data?.job?.company || companyBrief || briefLoading || briefTried) return;
    setBriefTried(true);
    setBriefLoading(true);
    const slug = data.job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    fetch(`/api/companies/${slug}/research?cacheOnly=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: data.job.company,
        role_hint: data.job.title,
        location_hint: data.job.location,
      }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.brief) setCompanyBrief(withBriefArrays(res.brief));
      })
      .catch(() => {
        // Soft-fail; the UI will show "research unavailable"
      })
      .finally(() => setBriefLoading(false));
  }, [tab, data?.job, companyBrief, briefLoading, briefTried]);

  const refreshBrief = async () => {
    if (!data?.job?.company) return;
    setBriefLoading(true);
    const slug = data.job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    try {
      const res = await fetch(`/api/companies/${slug}/research?refresh=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: data.job.company,
          role_hint: data.job.title,
          location_hint: data.job.location,
        }),
      });
      const json = await res.json();
      if (json.brief) {
        setCompanyBrief(withBriefArrays(json.brief));
        toast.success('Brief refreshed');
      } else toast.error(json.error || 'Refresh failed');
    } catch {
      toast.error('Refresh failed');
    } finally {
      setBriefLoading(false);
    }
  };

  const reEvaluate = async () => {
    // Re-rating an applied job is guarded server-side (it costs LLM quota to re-score a decision
    // already made), so ask first rather than letting the request 409 and surfacing raw API text.
    if (data?.application && !window.confirm("You've already applied to this job. Re-rate it anyway?")) return;
    setEvalLoading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/evaluate?refresh=1`, { method: 'POST' });
      const json = await res.json();
      if (res.ok && json.evaluation) {
        setEvaluation(json.evaluation);
        toast.success('Re-evaluated');
      } else {
        toast.error(json.error || 'Re-eval failed');
      }
    } catch {
      toast.error('Re-eval failed');
    } finally {
      setEvalLoading(false);
    }
  };

  // JD formatting (LLM prettify): the raw description shows immediately, so defer this call
  // until the user actually expands the JD — opening a job shouldn't fire an LLM format call.
  // Cached formatted versions (descriptionFormatted) still show without any call.
  const hasCachedFormatted = !!data?.job?.descriptionFormatted;
  const { data: lazyFormatted, isLoading: jdFormatting } = useSWR<string>(
    !hasCachedFormatted && data?.job && jdFormatRequested ? `/api/jobs/${jobId}/format` : null,
    formatFetcher,
    { dedupingInterval: 60_000, revalidateOnFocus: false }
  );
  const jdFormatted = data?.job?.descriptionFormatted || lazyFormatted || null;

  const generateDoc = async (type: 'cover-letter' | 'resume-variant') => {
    setGenerating(type);
    try {
      const res = await fetch(`/api/generate/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: Number(jobId) }),
      });
      const result = await res.json();
      if (result.error) {
        toast.error(result.error);
      } else if (type === 'cover-letter') {
        setCoverLetter(result.coverLetter);
        if (result.coverage) setCoverLetterCoverage(result.coverage);
        toast.success('Cover letter generated');
      } else {
        setResumeVariant(result.resumeVariant);
        if (result.coverage) setResumeCoverage(result.coverage);
        toast.success('Resume variant generated');
      }
    } catch {
      toast.error(`Failed to generate ${type === 'cover-letter' ? 'cover letter' : 'resume variant'}`);
    } finally {
      setGenerating(null);
    }
  };

  // Re-score this job against the AI-tailored résumé. A full re-rank + embed, so it is an explicit
  // button, never an auto-load — and it must be disabled until a variant actually exists.
  const scoreWithVariant = async () => {
    if (!resumeVariant) return;
    setTailoredScoreLoading(true);
    setTailoredScore(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/tailored-score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText: resumeVariant }),
      });
      const json = await res.json();
      if (json.error) {
        toast.error(json.error);
        return;
      }
      setTailoredScore({ score: json.score, defaultScore: json.defaultScore, delta: json.delta });
    } catch {
      toast.error('Failed to score the tailored résumé');
    } finally {
      setTailoredScoreLoading(false);
    }
  };

  const saveOutcome = async () => {
    try {
      const res = await fetch('/api/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: Number(jobId),
          status,
          notes,
          recruiter_name: recruiterName || null,
          recruiter_contact: recruiterContact || null,
          next_follow_up_at: nextFollowUp || null,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      setSaved(true);
      toast.success('Application saved');
      // Tracker list + matches list (applied badge) + digest are now stale
      revalidateApplications();
      revalidateMatches();
      revalidateDigest();
      revalidateDashboardStats();
      if (status === 'applied' && onApplied) {
        onApplied(Number(jobId));
      }
      setTimeout(() => setSaved(false), 2000);
    } catch {
      toast.error('Failed to save');
    }
  };

  const [isRemoving, setIsRemoving] = useState(false);
  const [isMarkingApplied, setIsMarkingApplied] = useState(false);

  const handleRemoveFromDashboard = async () => {
    const targetId = Number(jobId || data?.job?.id);
    if (!targetId) return;

    if (onHide) {
      onHide(targetId);
      return;
    }

    setIsRemoving(true);
    try {
      const res = await fetch(`/api/jobs/${targetId}/hide`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to remove job');

      toast(`Removed "${data?.job?.title || 'Job'}" from dashboard`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await fetch(`/api/jobs/${targetId}/hide`, { method: 'DELETE' });
              revalidateMatches();
              revalidateDigest();
              revalidateDashboardStats();
              toast.success('Restored to dashboard');
            } catch {
              toast.error('Failed to restore');
            }
          },
        },
      });

      revalidateMatches();
      revalidateDigest();
      revalidateDashboardStats();

      if (variant === 'page') {
        router.push('/');
      }
    } catch {
      toast.error('Failed to remove job from dashboard');
    } finally {
      setIsRemoving(false);
    }
  };

  // `keepPreviousData` (in the shared SWR config) means `data` still holds the PREVIOUS job while
  // the new one is in flight, so `isLoading && !data` never fired on a job switch and the panel
  // showed the old job's title, score and description for the whole request — reading as if the
  // click had opened the wrong job. Comparing the payload's id against the requested one detects
  // exactly that state. `keepPreviousData` stays on: the LIST genuinely wants it.
  const showingPreviousJob = !!data?.job && String(data.job.id) !== String(jobId);

  if ((isLoading && !data) || showingPreviousJob) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || !data.job) {
    return (
      <div className="text-center text-muted-foreground py-12">
        Job not found.
        <div className="mt-2">
          <Button asChild variant="link" size="sm">
            <Link href="/">Back to matches</Link>
          </Button>
        </div>
      </div>
    );
  }

  const { job, match } = data;
  const finalPct = match ? Math.min(100, Math.max(0, Math.round(match.finalScore * 100))) : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {variant === 'page' && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href="/">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to matches
          </Link>
        </Button>
        {siblings.length > 1 && currentIdx >= 0 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="sm"
              onClick={goPrev}
              disabled={prevId === null}
              className="h-8"
              title="Previous match (])"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Button>
            <span className="tabular px-1">
              {currentIdx + 1} / {siblings.length}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={goNext}
              disabled={nextId === null}
              className="h-8"
              title="Next match (])"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      )}

      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-1">
              <CardTitle className="text-2xl leading-tight">{job.title}</CardTitle>
              <CardDescription className="text-base text-foreground/80">{job.company}</CardDescription>
              <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {job.location || 'Location unspecified'}
                </span>
                <span>·</span>
                <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground/70" />
                  {formatJobAge(job.postedAt, job.ingestedAt, match?.ageDays)}
                </span>
                <span>·</span>
                <span className="font-mono text-xs">
                  {(() => {
                    const url = (job.url || '').toLowerCase();
                    if (job.source === 'linkedin' || url.includes('linkedin.com')) return 'LinkedIn';
                    if (job.source === 'naukri' || url.includes('naukri.com')) return 'Naukri';
                    if (job.source === 'indeed' || url.includes('indeed.com')) return 'Indeed';
                    return job.source;
                  })()}
                </span>
                {match?.applyType && (
                  <Badge variant={match.applyType === 'easy_apply' ? 'info' : match.applyType === 'direct_apply' ? 'warning' : 'muted'} className="text-[10px]">
                    {match.applyType === 'easy_apply' ? 'Easy Apply' : match.applyType === 'direct_apply' ? 'Direct Apply' : match.applyType === 'external' ? 'External' : 'Apply type unknown'}
                  </Badge>
                )}
              </div>
            </div>
            {job.domainPriority === 1 && (
              <Badge variant="info">
                <Sparkles className="mr-1 h-3 w-3" />
                Healthcare IT
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Quick facts — at-a-glance summary like Naukri's listing card */}
          {job.facts && (
            <div className="flex flex-wrap items-stretch gap-2">
              {job.facts.salaryText ? (
                <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-success/80">Salary</p>
                  <p className="font-mono text-sm font-semibold tabular text-success">{job.facts.salaryText}</p>
                </div>
              ) : (
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Salary</p>
                  <p className="text-xs text-muted-foreground italic">not disclosed</p>
                </div>
              )}
              {job.facts.experienceText && (
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Experience</p>
                  <p className="font-mono text-sm font-semibold tabular">{job.facts.experienceText}</p>
                </div>
              )}
              {job.facts.workMode && (
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Work mode</p>
                  <p className="text-sm font-medium capitalize">{job.facts.workMode}</p>
                </div>
              )}
              {job.facts.employmentType && (
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Type</p>
                  <p className="text-sm font-medium capitalize">{job.facts.employmentType}</p>
                </div>
              )}
              {(job.location || data.job.location) && (
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Location</p>
                  <p className="text-sm font-medium truncate max-w-[240px]">{job.location || data.job.location}</p>
                </div>
              )}
            </div>
          )}
          {/* The fit score and WHY it scored that. Same chips as the list row, so the reason a job
              ranked where it did is visible at the point of decision instead of being implicit in
              a number. Negatives come first (buildReasons orders them). */}
          {match && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <ScoreBadge score={match.finalScore} size="lg" />
              <span className="mr-1 text-[11px] text-muted-foreground">fit</span>
              {(match.reasons || []).map((r, i) => (
                <Badge
                  key={`${r.kind}-${i}`}
                  variant={r.tone === 'good' ? 'success' : r.tone === 'bad' ? 'destructive' : 'muted'}
                  className="text-[10px] font-normal"
                >
                  {r.label}
                </Badge>
              ))}
            </div>
          )}
          {/* Offer only what this portal can ACTUALLY do.
              This used to render "Auto-apply" for every job that had a URL. For a LinkedIn or Lever
              posting that meant a button, a live URL check and a spinner before finally saying no —
              for a submitter that was never written. Now the URL decides the affordance up front:
              Greenhouse/Ashby really submit, everything else we can open gets the honest
              "Open & autofill" (it fills fields; the user clicks Submit), and portals we can't help
              with show the plain link only. */}
          {job.url && (() => {
            const strategy = identifySubmissionStrategy(job.url).strategy;
            const assisted = strategy !== 'manual';
            const isApplied = Boolean(data?.application?.status && data.application.status !== 'rejected');

            if (isApplied) {
              return (
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="success" className="gap-1.5 py-1.5 px-3 text-xs font-medium">
                    <CheckCircle2 className="h-4 w-4" /> Applied Successfully
                  </Badge>
                  {data?.application?.applied_date && (
                    <span className="text-xs text-muted-foreground">on {data.application.applied_date}</span>
                  )}
                  <Button asChild variant="outline" size="sm">
                    <Link href="/tracker">View in Tracker</Link>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <a href={job.url} target="_blank" rel="noopener noreferrer">
                      Open posting <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                    onClick={handleRemoveFromDashboard}
                    disabled={isRemoving}
                    title="Remove this job from your dashboard"
                  >
                    {isRemoving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                    )}
                    Remove from Dashboard
                  </Button>
                </div>
              );
            }

            return (
              <div className="flex items-center gap-2 flex-wrap">
                {assisted && (
                  <Button onClick={() => setAutoApplyOpen(true)}>
                    <Wand2 className="h-3.5 w-3.5" />
                    {strategyActionLabel(strategy)}
                  </Button>
                )}
                <Button asChild variant={assisted ? 'outline' : 'default'}>
                  <a href={job.url} target="_blank" rel="noopener noreferrer">
                    Apply on company site
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isMarkingApplied}
                  onClick={async () => {
                    const targetId = Number(jobId || data?.job?.id);
                    if (!targetId) {
                      toast.error('Job ID not found');
                      return;
                    }
                    setIsMarkingApplied(true);
                    try {
                      const res = await fetch('/api/outcomes', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jobId: targetId, status: 'applied' }),
                      });
                      if (!res.ok) throw new Error();
                      revalidateApplications();
                      revalidateMatches();
                      revalidateDigest();
                      revalidateDashboardStats();

                      if (onApplied) {
                        onApplied(targetId);
                      }

                      if (variant === 'pane') {
                        toast.success('Marked as Applied! Moved to Tracker', {
                          action: {
                            label: 'View in Tracker',
                            onClick: () => router.push('/tracker'),
                          },
                        });
                      } else {
                        toast.success('Marked as Applied! Moved to Tracker');
                        router.push('/tracker');
                      }
                    } catch {
                      toast.error('Failed to mark as applied');
                    } finally {
                      setIsMarkingApplied(false);
                    }
                  }}
                >
                  {isMarkingApplied ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-success mr-1" />
                  )}
                  Mark as Applied
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                  onClick={handleRemoveFromDashboard}
                  disabled={isRemoving}
                  title="Remove this job from your dashboard"
                >
                  {isRemoving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                  )}
                  Remove from Dashboard
                </Button>
                {assisted && !submitsDirectly(strategy) && (
                  <span className="text-[11px] text-muted-foreground">
                    Fills the form for you — you click Submit
                  </span>
                )}
              </div>
            );
          })()}
        </CardContent>
      </Card>


      {/* Sticky tab strip. Sticks inside the pane's own scroll container, so the job identity and
          navigation stay put once the header scrolls away. Uses the segmented-control idiom
          already in the repo (see src/app/import/page.tsx) rather than adding a Radix tabs
          dependency — this project only carries dialog/slot/tooltip. */}
      <div className="sticky top-0 z-10 -mx-1 border-b border-border/60 bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <p className="mb-1.5 truncate text-[11px] text-muted-foreground">{job.title} · {job.company}</p>
        <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
          {DETAIL_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded px-2.5 py-1 text-xs transition-colors',
                tab === t.key ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {/* A dot marks a tab that already HAS content. Moving the rating and company research
                  behind tabs made them feel deleted; this makes it visible that they're there. */}
              {((t.key === 'ai' && evaluation) || (t.key === 'company' && (companyBrief || compData || ambitionbox || layoffs))) && (
                <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-success align-middle" />
              )}
            </button>
          ))}
        </div>
      </div>


      <AutoApplyDialog
        jobId={Number(jobId)}
        open={autoApplyOpen}
        onOpenChange={setAutoApplyOpen}
        onSubmitted={() => {
          revalidateApplications();
          revalidateMatches();
          revalidateDigest();
          revalidateDashboardStats();
          if (onApplied) {
            onApplied(Number(jobId));
          }
          onAutoApplyNext?.();
        }}
      />

      {/* OVERVIEW — the job description is here, and it is the DEFAULT tab. It used to be
          section 12 of 12, behind three cards that render "nothing here yet" placeholders and a
          ~90-line tracking form, and clamped to 18rem: reading the JD took a long scroll AND a
          click. Everything else moved behind a tab. */}
      {tab === 'overview' && (
        <>
          {/* Compact AI verdict on the LANDING tab. The full breakdown lives in "AI review", but
              putting nothing here made the rating look like it had been removed. */}
          {evaluation && (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 py-3">
                {/* The AI verdict is a 1-5 rating and is shown AS a 1-5 rating.
                    It used to render through <ScoreBadge score={overall_score / 5}> — the same
                    component, palette and 0-100 look as the composite fit score sitting inches
                    away — so an AI 3 displayed as "60" next to a fit "82" and read as a second,
                    contradictory fit number. (It didn't even match the composite's own conversion,
                    which is (n-1)/4, so the same 3 was 60 here and 50 inside the score.) Two
                    different scales must not share one badge. */}
                <span
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-sm font-semibold tabular',
                    evaluation.overall_score >= 4
                      ? 'bg-success/15 text-success border-success/30'
                      : evaluation.overall_score >= 3
                        ? 'bg-warning/15 text-warning border-warning/30'
                        : 'bg-destructive/15 text-destructive border-destructive/30',
                  )}
                  title="The AI's own 1-5 rating for this job — separate from the fit score"
                >
                  AI {fmtScore(evaluation.overall_score)}/5
                </span>
                <Badge
                  variant={evaluation.recommendation === 'apply' ? 'success' : evaluation.recommendation === 'skip' ? 'destructive' : 'warning'}
                  className="capitalize"
                >
                  AI: {evaluation.recommendation}
                </Badge>
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {evaluation.strategy_notes || evaluation.cv_alignment_notes || 'AI review available'}
                </p>
                <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => setTab('ai')}>
                  Full AI review →
                </Button>
              </CardContent>
            </Card>
          )}
          {!evaluation && (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 py-3">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  Not rated yet. The AI review scores this role against your résumé and targets.
                </p>
                <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={() => setTab('ai')}>
                  Rate this job →
                </Button>
              </CardContent>
            </Card>
          )}
          {/* JD */}
          {job.description && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">Job description</CardTitle>
                  <div className="flex items-center gap-1">
                    {/* Explicit, opt-in LLM call — never fires on open. */}
                    {!jdFormatted && job.description && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setJdFormatRequested(true)}
                        disabled={jdFormatting}
                        className="h-7"
                        title="Clean this up with the LLM (makes one call)"
                      >
                        {jdFormatting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                        Tidy up
                      </Button>
                    )}
                    {(jdFormatted || job.description) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setJdExpanded((v) => !v)}
                        className="h-7"
                      >
                        {jdExpanded ? 'Collapse' : 'Expand'}
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {(() => {
                  const content = jdFormatted || (job.description ? formatJobDescription(job.description) : null);
                  if (!content && jdFormatting) {
                    return (
                      <div className="space-y-3">
                        <Skeleton className="h-4 w-32" />
                        <div className="space-y-1.5">
                          <Skeleton className="h-3 w-full" />
                          <Skeleton className="h-3 w-[95%]" />
                          <Skeleton className="h-3 w-[88%]" />
                        </div>
                      </div>
                    );
                  }
                  if (!content) return null;

                  return (
                    <>
                      {jdFormatting && (
                        <p className="mb-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> Polishing with AI…
                        </p>
                      )}
                      <div
                        className={cn(
                          'text-foreground/90 relative text-sm leading-relaxed',
                          !jdExpanded && 'max-h-[18rem] overflow-hidden',
                        )}
                      >
                        <ReactMarkdown components={MD_COMPONENTS}>{content}</ReactMarkdown>
                        {!jdExpanded && (
                          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent pointer-events-none" />
                        )}
                      </div>
                    </>
                  );
                })()}
                {!jdExpanded && (jdFormatted || job.description) && (
                  <div className="mt-3">
                    <Button variant="link" size="sm" onClick={() => setJdExpanded(true)} className="h-auto p-0">
                      Read full description
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          {!job.description && (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
              No description was captured for this posting. Try &quot;Apply on company site&quot; above.
            </CardContent></Card>
          )}
        </>
      )}

      {tab === 'ai' && (
        <>
          {/* LLM Evaluation Panel — replaces basic cosine breakdown */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Target className="h-4 w-4" />
                  Evaluation
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={reEvaluate} disabled={evalLoading} className="h-7">
                  {evalLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Re-evaluate
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {evalLoading && !evaluation ? (
                <div className="space-y-4">
                  <div className="flex gap-3">
                    <Skeleton className="h-20 w-32" />
                    <Skeleton className="h-20 flex-1" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Skeleton className="h-20" />
                    <Skeleton className="h-20" />
                    <Skeleton className="h-20" />
                    <Skeleton className="h-20" />
                  </div>
                </div>
              ) : !evaluation ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  Evaluation not yet run. <Button variant="link" size="sm" onClick={reEvaluate} className="h-auto p-0">Run now</Button>
                </div>
              ) : (
                <>
                  {/* Overall verdict */}
                  <div className="flex items-center gap-4 rounded-md border p-4 bg-muted/30">
                    <div
                      className={cn(
                        'flex h-16 w-16 shrink-0 items-center justify-center rounded-md font-mono text-2xl font-bold tabular',
                        evaluation.overall_score >= 4 ? 'bg-success/15 text-success border border-success/30' :
                        evaluation.overall_score >= 3 ? 'bg-warning/15 text-warning border border-warning/30' :
                        'bg-destructive/15 text-destructive border border-destructive/30'
                      )}
                    >
                      {fmtScore(evaluation.overall_score)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {evaluation.recommendation === 'apply' ? (
                          <Badge variant="success"><ThumbsUp className="mr-1 h-3 w-3" /> Apply</Badge>
                        ) : evaluation.recommendation === 'consider' ? (
                          <Badge variant="warning"><CircleHelp className="mr-1 h-3 w-3" /> Consider</Badge>
                        ) : (
                          <Badge variant="destructive"><ThumbsDown className="mr-1 h-3 w-3" /> Skip</Badge>
                        )}
                      </div>
                      <p className="text-sm text-foreground/85 mt-2 leading-relaxed">
                        {evaluation.strategy_notes}
                      </p>
                    </div>
                  </div>

                  {/* Per-dimension breakdown */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <DimensionPanel
                      icon={ScrollText}
                      label="CV alignment"
                      score={evaluation.cv_alignment_score}
                      notes={evaluation.cv_alignment_notes}
                    />
                    <DimensionPanel
                      icon={Target}
                      label="North Star fit"
                      score={evaluation.north_star_fit_score}
                      notes={evaluation.north_star_fit_notes}
                    />
                    <DimensionPanel
                      icon={Banknote}
                      label="Compensation"
                      score={evaluation.compensation_score}
                      notes={evaluation.compensation_notes}
                    />
                    <DimensionPanel
                      icon={ShieldCheck}
                      label="Culture & red flags"
                      score={evaluation.culture_score}
                      notes={evaluation.culture_notes}
                    />
                  </div>
                </>
              )}

              {/* Compact gap analysis below evaluation */}
              {match?.gapAnalysis && (match.gapAnalysis.matchedSkills?.length > 0 || match.gapAnalysis.missingKeywords?.length > 0) && (
                <>
                  <Separator />
                  <details>
                    <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
                      Keyword overlap (raw signal)
                    </summary>
                    <div className="mt-3 space-y-3">
                      {match.gapAnalysis.matchedSkills?.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-xs text-muted-foreground">
                            Skills present in both ({match.gapAnalysis.matchedSkills.length}):
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {match.gapAnalysis.matchedSkills.map((s, i) => (
                              <Badge key={i} variant="success" className="font-normal">{s}</Badge>
                            ))}
                          </div>
                        </div>
                      )}
                      {match.gapAnalysis.missingKeywords?.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-xs text-muted-foreground">
                            Keywords in JD not in resume:
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {match.gapAnalysis.missingKeywords.map((s, i) => (
                              <Badge key={i} variant="muted" className="font-normal">{s}</Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </details>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {tab === 'company' && (
        <>
          {/* Company Brief — recession-resilience-first lens */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Building className="h-4 w-4" />
                  Company brief
                  <span className="text-xs font-normal text-muted-foreground">— recession resilience &amp; decision</span>
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={refreshBrief} disabled={briefLoading} className="h-7">
                  {briefLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {briefLoading && !companyBrief ? (
                <div className="space-y-3">
                  <Skeleton className="h-20 w-full" />
                  <div className="grid grid-cols-2 gap-3">
                    <Skeleton className="h-16" />
                    <Skeleton className="h-16" />
                    <Skeleton className="h-16" />
                    <Skeleton className="h-16" />
                  </div>
                </div>
              ) : !companyBrief ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  No brief yet. <Button variant="link" size="sm" onClick={refreshBrief} className="h-auto p-0">Run research now</Button>
                </div>
              ) : (
                <>
                  {/* Top-line verdict */}
                  <div className="flex items-center gap-4 rounded-md border p-4 bg-muted/30">
                    <div
                      className={cn(
                        'flex h-16 w-16 shrink-0 items-center justify-center rounded-md font-mono text-2xl font-bold tabular',
                        companyBrief.overall_score >= 4 ? 'bg-success/15 text-success border border-success/30' :
                        companyBrief.overall_score >= 3 ? 'bg-warning/15 text-warning border border-warning/30' :
                        'bg-destructive/15 text-destructive border border-destructive/30'
                      )}
                    >
                      {fmtScore(companyBrief.overall_score)}
                    </div>
                    <div className="flex-1 min-w-0">
                      {companyBrief.recommendation === 'apply' ? (
                        <Badge variant="success"><ThumbsUp className="mr-1 h-3 w-3" /> Apply</Badge>
                      ) : companyBrief.recommendation === 'hold' ? (
                        <Badge variant="warning"><CircleHelp className="mr-1 h-3 w-3" /> Hold</Badge>
                      ) : (
                        <Badge variant="destructive"><ThumbsDown className="mr-1 h-3 w-3" /> Pass</Badge>
                      )}
                      <p className="text-sm text-foreground/85 mt-2 leading-relaxed">
                        {companyBrief.financial_health_summary}
                      </p>
                    </div>
                  </div>

                  {/* The 4 dimensions */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <DimensionPanel
                      icon={Activity}
                      label="Financial resilience"
                      score={companyBrief.financial_health_score}
                      notes={[companyBrief.funding_summary, companyBrief.layoffs_summary, companyBrief.growth_signal].filter(Boolean).join(' · ')}
                    />
                    <DimensionPanel
                      icon={Users}
                      label="Culture & people"
                      score={companyBrief.culture_score}
                      notes={companyBrief.culture_summary + (companyBrief.retention_signal ? ` · ${companyBrief.retention_signal}` : '')}
                    />
                    <DimensionPanel
                      icon={Banknote}
                      label="Compensation"
                      score={companyBrief.overall_score}  /* using overall as proxy; comp has no separate score */
                      notes={companyBrief.comp_summary}
                    />
                    <DimensionPanel
                      icon={ShieldCheck}
                      label="Legitimacy"
                      score={companyBrief.legitimacy_score}
                      notes={companyBrief.legitimacy_notes}
                    />
                  </div>

                  {/* Themes / concerns */}
                  {(companyBrief.positive_themes.length > 0 || companyBrief.concerns.length > 0) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {companyBrief.positive_themes.length > 0 && (
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
                            <ThumbsUp className="h-3 w-3" /> Positive themes
                          </p>
                          <ul className="text-sm space-y-1 text-foreground/85">
                            {companyBrief.positive_themes.map((t, i) => (
                              <li key={i} className="flex items-start gap-1.5"><span className="text-success">·</span> {t}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {companyBrief.concerns.length > 0 && (
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
                            <ThumbsDown className="h-3 w-3" /> Concerns
                          </p>
                          <ul className="text-sm space-y-1 text-foreground/85">
                            {companyBrief.concerns.map((t, i) => (
                              <li key={i} className="flex items-start gap-1.5"><span className="text-destructive">·</span> {t}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Questions for recruiter */}
                  {companyBrief.questions_for_recruiter.length > 0 && (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
                        <HelpCircle className="h-3 w-3" /> Ask the recruiter
                      </p>
                      <ul className="text-sm space-y-1 text-foreground/85">
                        {companyBrief.questions_for_recruiter.map((q, i) => (
                          <li key={i} className="flex items-start gap-1.5"><span className="text-info">·</span> {q}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Sources */}
                  {companyBrief.evidence_sources.length > 0 && (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
                        <LinkIcon className="h-3 w-3" /> Sources
                      </p>
                      <ul className="text-xs space-y-0.5 text-muted-foreground">
                        {companyBrief.evidence_sources.map((s, i) => (
                          <li key={i} className="truncate">
                            <a href={s.url} target="_blank" rel="noreferrer" className="text-info hover:underline">
                              {s.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Layoffs — hard data from Layoffs.fyi (bulk-ingested via npm run ingest:layoffs) */}
          {layoffs && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4" />
                  Layoff history
                  <span className="text-xs font-normal text-muted-foreground">— Layoffs.fyi (real data)</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {layoffs.totalEvents === 0 ? (
                  <div className="rounded-md border p-3 bg-success/5 border-success/30 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md border border-success/30 bg-success/15 text-success px-2 py-0.5 text-[11px] font-semibold uppercase">No events</span>
                      <span className="text-muted-foreground">{layoffs.riskNote}</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={cn(
                      'rounded-md border p-3 text-sm',
                      layoffs.riskFlag === 'high' && 'bg-destructive/5 border-destructive/30',
                      layoffs.riskFlag === 'moderate' && 'bg-warning/5 border-warning/30',
                      layoffs.riskFlag === 'low' && 'bg-muted/30 border-border',
                    )}>
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className={cn(
                          'rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase',
                          layoffs.riskFlag === 'high' && 'border-destructive/30 bg-destructive/15 text-destructive',
                          layoffs.riskFlag === 'moderate' && 'border-warning/30 bg-warning/15 text-warning',
                          layoffs.riskFlag === 'low' && 'border-border bg-muted text-muted-foreground',
                        )}>
                          Risk: {layoffs.riskFlag}
                        </span>
                        <span className="text-foreground/85">{layoffs.riskNote}</span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground tabular">
                        {layoffs.totalEvents} event{layoffs.totalEvents === 1 ? '' : 's'} on record · {layoffs.totalLaidOff.toLocaleString()} total laid off
                      </p>
                    </div>
                    {layoffs.events.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Events</p>
                        {layoffs.events.slice(0, 5).map((e, i) => (
                          <div key={i} className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-1.5 text-sm">
                            <div className="flex items-baseline gap-3 min-w-0 flex-1">
                              <span className="tabular text-muted-foreground text-xs shrink-0 w-20">{e.layoff_date || '—'}</span>
                              <span className="font-medium tabular">{e.laid_off_count?.toLocaleString() || '?'}</span>
                              {e.laid_off_pct !== null && (
                                <span className="text-muted-foreground text-xs">({Math.round((e.laid_off_pct || 0) * 100)}%)</span>
                              )}
                              {e.stage && <span className="text-muted-foreground text-xs">· {e.stage}</span>}
                            </div>
                            {e.source_url && (
                              <a href={e.source_url} target="_blank" rel="noreferrer" className="text-info text-xs hover:underline shrink-0">
                                source ↗
                              </a>
                            )}
                          </div>
                        ))}
                        {layoffs.events.length > 5 && (
                          <p className="text-xs text-muted-foreground tabular">+ {layoffs.events.length - 5} older events</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Ambitionbox — Indian-side ratings + salaries (cached per company) */}
          {(ambitionboxLoading || ambitionbox) && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Users className="h-4 w-4" />
                    Ambitionbox
                    <span className="text-xs font-normal text-muted-foreground">— India ratings &amp; salaries</span>
                  </CardTitle>
                  <Button variant="ghost" size="sm" onClick={refreshAmbitionbox} disabled={ambitionboxLoading} className="h-7">
                    {ambitionboxLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Refresh
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {ambitionboxLoading && !ambitionbox ? (
                  <div className="space-y-2">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-32 w-full" />
                  </div>
                ) : !ambitionbox ? (
                  <div className="text-sm text-muted-foreground py-4 text-center">No Ambitionbox page for this company.</div>
                ) : (
                  <>
                    {/* Top-line: overall rating + company facts */}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className={cn(
                        'rounded-md border p-3',
                        ambitionbox.ratings.overall >= 4 ? 'bg-success/5 border-success/30'
                        : ambitionbox.ratings.overall >= 3.5 ? 'bg-info/5 border-info/30'
                        : ambitionbox.ratings.overall >= 3 ? 'bg-warning/5 border-warning/30'
                        : 'bg-destructive/5 border-destructive/30',
                      )}>
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Overall rating</p>
                        <p className="mt-1 text-2xl font-semibold tabular">
                          {ambitionbox.ratings.overall.toFixed(1)}
                          <span className="ml-1 text-sm font-normal text-muted-foreground">/ 5</span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground tabular">
                          {ambitionbox.ratings.totalReviews.toLocaleString()} reviews
                          {ambitionbox.ratings.industryRating !== null && (
                            <span> · industry avg {ambitionbox.ratings.industryRating.toFixed(2)}</span>
                          )}
                          {ambitionbox.ratings.lastUpdatedAt && (
                            <span> · updated {ambitionbox.ratings.lastUpdatedAt}</span>
                          )}
                        </p>
                      </div>
                      <div className="rounded-md border p-3 bg-muted/30 text-xs space-y-0.5">
                        {ambitionbox.hq && <p><span className="text-muted-foreground">HQ:</span> {ambitionbox.hq}</p>}
                        {ambitionbox.industry && <p><span className="text-muted-foreground">Industry:</span> {ambitionbox.industry}</p>}
                        {ambitionbox.employeeBand && <p><span className="text-muted-foreground">Size:</span> {ambitionbox.employeeBand}</p>}
                        {ambitionbox.followersCount > 0 && (
                          <p className="text-muted-foreground tabular">{ambitionbox.followersCount.toLocaleString()} followers</p>
                        )}
                      </div>
                    </div>

                    {/* 7-dimension breakdown */}
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1.5">Dimensions</p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                        {([
                          ['Work-life', ambitionbox.ratings.workLife],
                          ['Culture', ambitionbox.ratings.companyCulture],
                          ['Comp & benefits', ambitionbox.ratings.compensationBenefits],
                          ['Career growth', ambitionbox.ratings.careerGrowth],
                          ['Job security', ambitionbox.ratings.jobSecurity],
                          ['Work satisfaction', ambitionbox.ratings.workSatisfaction],
                          ['Skill development', ambitionbox.ratings.skillDevelopment],
                        ] as const).map(([label, value]) => (
                          <div key={label} className={cn(
                            'rounded border px-2 py-1.5 bg-background',
                            value >= 3.5 && 'border-success/30',
                            value < 3 && 'border-destructive/30',
                          )}>
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</div>
                            <div className={cn(
                              'text-sm font-semibold tabular',
                              value >= 3.5 ? 'text-success' : value >= 3 ? 'text-foreground' : 'text-destructive',
                            )}>
                              {value.toFixed(1)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Role-matched salary */}
                    {ambitionboxRoleSalary && (
                      <div className="rounded-md border p-3 bg-info/5 border-info/30">
                        <p className="text-xs uppercase tracking-wide text-info">Salary for &quot;{ambitionboxRoleSalary.jobTitle}&quot;</p>
                        <p className="mt-1 text-xl font-semibold tabular">
                          ₹{(ambitionboxRoleSalary.minCtc / 100000).toFixed(1)}L – ₹{(ambitionboxRoleSalary.maxCtc / 100000).toFixed(1)}L
                          <span className="ml-2 text-xs font-normal text-muted-foreground">per yr (CTC)</span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground tabular">
                          Average ₹{(ambitionboxRoleSalary.avgCtc / 100000).toFixed(1)}L
                          {' · '}{ambitionboxRoleSalary.dataPoints} reports
                          {' · '}{ambitionboxRoleSalary.minExperience}-{ambitionboxRoleSalary.maxExperience} yrs experience
                        </p>
                      </div>
                    )}

                    {/* All salary breakdown collapsible */}
                    {ambitionbox.salaries.length > 0 && (
                      <details className="rounded-md border">
                        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
                          Full salary breakdown ({ambitionbox.salaries.length} roles)
                        </summary>
                        <div className="px-3 py-2 space-y-1.5 text-xs">
                          {ambitionbox.salaries.slice(0, 12).map((s) => (
                            <div key={s.jobTitle} className="flex items-center justify-between gap-3 border-b py-1 last:border-0">
                              <div className="min-w-0 flex-1 truncate">{s.jobTitle}</div>
                              <div className="tabular font-medium text-sm shrink-0">
                                ₹{(s.minCtc / 100000).toFixed(1)}L–₹{(s.maxCtc / 100000).toFixed(1)}L
                              </div>
                              <div className="tabular text-muted-foreground text-[10px] shrink-0 w-20 text-right">
                                {s.dataPoints} rpts
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {/* Review samples */}
                    {ambitionbox.reviewSamples.length > 0 && (
                      <details className="rounded-md border">
                        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
                          Review samples ({ambitionbox.reviewSamples.length})
                        </summary>
                        <div className="px-3 py-2 space-y-3 text-xs">
                          {ambitionbox.reviewSamples.slice(0, 3).map((r, i) => (
                            <div key={i} className="space-y-1 border-l-2 border-muted pl-2">
                              {r.jobLocation && <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.jobLocation}</p>}
                              {r.likes && (
                                <p><span className="text-success font-medium">+</span> <span className="text-foreground/85">{r.likes.slice(0, 220)}{r.likes.length > 220 ? '…' : ''}</span></p>
                              )}
                              {r.dislikes && (
                                <p><span className="text-destructive font-medium">−</span> <span className="text-foreground/85">{r.dislikes.slice(0, 220)}{r.dislikes.length > 220 ? '…' : ''}</span></p>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    <p className="text-xs text-muted-foreground">
                      Source:{' '}
                      <a href={ambitionbox.sourceUrl} target="_blank" rel="noreferrer" className="text-info hover:underline">
                        {ambitionbox.sourceUrl}
                      </a>
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Compensation — hard data from Levels.fyi (cached per company × region) */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Banknote className="h-4 w-4" />
                  Compensation
                  <span className="text-xs font-normal text-muted-foreground">— Levels.fyi (real data)</span>
                </CardTitle>
                <div className="flex items-center gap-1">
                  {/* Region toggle — switching re-fetches from server (or cache) */}
                  <div className="inline-flex rounded-md border bg-background overflow-hidden">
                    {(['IN', 'US'] as const).map((r) => (
                      <button
                        key={r}
                        onClick={() => refreshComp(r)}
                        className={cn(
                          'px-2 py-1 text-xs font-medium transition-colors',
                          compRegion === r ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50',
                        )}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => refreshComp()} disabled={compLoading} className="h-7">
                    {compLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {compLoading && !compData ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : !compData ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  No Levels.fyi data for this company in {compRegion === 'IN' ? 'India' : 'US'}.{' '}
                  <Button variant="link" size="sm" onClick={() => refreshComp()} className="h-auto p-0">Try again</Button>{' '}
                  or switch region.
                </div>
              ) : (
                <>
                  {/* Top-line median + role match */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border p-3 bg-muted/30">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Company median (all roles)</p>
                      <p className="mt-1 text-xl font-semibold tabular">
                        {compData.medianTotalUsd ? `$${compData.medianTotalUsd.toLocaleString()}` : '—'}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">USD / yr · TC</span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground tabular">
                        {compData.sampleCount} reports · region: {compData.region}
                      </p>
                    </div>
                    {compRoleMatch ? (
                      <div className="rounded-md border p-3 bg-info/5 border-info/30">
                        <p className="text-xs uppercase tracking-wide text-info">Match for &quot;{job.title}&quot;</p>
                        <p className="mt-1 text-xl font-semibold tabular">
                          {(() => {
                            const v = compRoleMatch.totalAtLevel || compRoleMatch.totalForFamily;
                            return v ? `$${v.toLocaleString()}` : '—';
                          })()}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">USD / yr · TC</span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {compRoleMatch.jobFamily}
                          {compRoleMatch.level && ` · ${compRoleMatch.level}`}
                          {' · '}{compRoleMatch.sampleCount} reports
                          {compRoleMatch.matchSource === 'family' && <span className="italic"> · family median (level not matched)</span>}
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-md border p-3 bg-muted/30 text-xs text-muted-foreground">
                        No specific role-level match. Browse the full breakdown below.
                      </div>
                    )}
                  </div>

                  {/* Full breakdown collapsible */}
                  <details className="rounded-md border">
                    <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
                      Full breakdown ({compData.jobFamilies.length} job families)
                    </summary>
                    <div className="px-3 py-2 space-y-3 text-xs">
                      {compData.jobFamilies.map((fam) => {
                        const totalCount = (fam.breakdown || []).reduce((s, b) => s + (b.count || 0), 0);
                        if (totalCount === 0) return null;
                        return (
                          <div key={fam.slug}>
                            <div className="flex items-baseline justify-between">
                              <span className="font-medium">{fam.name}</span>
                              <span className="text-muted-foreground tabular">{totalCount} reports</span>
                            </div>
                            {fam.breakdown && fam.breakdown.length > 0 && (
                              <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px]">
                                {fam.breakdown.map((lvl) => (
                                  <div key={lvl.level} className="rounded border px-2 py-1 bg-background">
                                    <div className="font-mono text-muted-foreground">{lvl.level}</div>
                                    <div className="tabular font-medium">
                                      ${lvl.total.toLocaleString()}
                                    </div>
                                    <div className="text-muted-foreground tabular text-[10px]">{lvl.count} reports</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </details>

                  <p className="text-xs text-muted-foreground">
                    Source:{' '}
                    <a href={compData.sourceUrl} target="_blank" rel="noreferrer" className="text-info hover:underline">
                      {compData.sourceUrl}
                    </a>
                  </p>
                </>
              )}
            </CardContent>
          </Card>

        </>
      )}

      {tab === 'apply' && (
        <>
          {/* Generation */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Generate documents</CardTitle>
              <CardDescription>Grounded in your parsed resume. No fabricated skills.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <Button
                  onClick={() => generateDoc('cover-letter')}
                  disabled={generating === 'cover-letter'}
                  variant="default"
                  size="sm"
                >
                  {generating === 'cover-letter' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileSignature className="h-3.5 w-3.5" />
                  )}
                  {coverLetter ? 'Regenerate cover letter' : 'Generate cover letter'}
                </Button>
                {coverLetter && (
                  <div className="rounded-md border bg-card p-3">
                    {coverLetterCoverage && <KeywordCoverageBadge coverage={coverLetterCoverage} />}
                    <CoverLetterView
                      markdown={coverLetter}
                      company={data.job.company}
                      jobTitle={data.job.title}
                    />
                  </div>
                )}
              </div>

              <Separator />

              <div className="space-y-3">
                <Button
                  onClick={() => generateDoc('resume-variant')}
                  disabled={generating === 'resume-variant'}
                  variant="outline"
                  size="sm"
                >
                  {generating === 'resume-variant' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  {resumeVariant ? 'Regenerate resume variant' : 'Generate resume variant'}
                </Button>
                {resumeVariant && (
                  <div className="rounded-md border bg-card">
                    <div className="flex items-center justify-between border-b px-3 py-1.5">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resume variant</span>
                      <div className="flex items-center gap-1">
                        <CopyButton text={resumeVariant} />
                        <DownloadDocxButton markdown={resumeVariant} fileName={`resume-${data.job.company}`} />
                        <DownloadPdfButton markdown={resumeVariant} jobId={String(jobId)} fileName={`resume-${data.job.company}`} />
                      </div>
                    </div>
                    {resumeCoverage && <KeywordCoverageBadge coverage={resumeCoverage} />}
                    {/* Fit score WITH this variant — recomputed against the tailored text, not the
                        active profile. The list score is the "default" read-only comparison. */}
                    <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Fit score with this version
                      </span>
                      {tailoredScore ? (
                        <>
                          {data.match?.score != null && (
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <ScoreBadge score={data.match.finalScore} size="sm" />
                              <span>your résumé</span>
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">→</span>
                          <span className="flex items-center gap-1.5 text-xs">
                            <ScoreBadge score={tailoredScore.score / 100} size="sm" />
                            <span className="text-muted-foreground">tailored</span>
                          </span>
                          {tailoredScore.delta != null && tailoredScore.delta !== 0 && (
                            <Badge
                              variant={tailoredScore.delta > 0 ? 'success' : 'destructive'}
                              className="text-[10px] font-normal"
                            >
                              {tailoredScore.delta > 0 ? '▲' : '▼'} {Math.abs(tailoredScore.delta)}
                            </Badge>
                          )}
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={scoreWithVariant}
                          disabled={tailoredScoreLoading}
                          title="Re-runs the match score against the tailored résumé text (~5-8s): shows what this job scores if the tailored version were your résumé."
                        >
                          {tailoredScoreLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                          Score this version
                        </Button>
                      )}
                    </div>
                    <div className="px-6 py-5 max-h-[36rem] overflow-y-auto">
                      <ReactMarkdown components={MD_COMPONENTS}>{resumeVariant}</ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Tracking */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Application</CardTitle>
              <CardDescription>Status and notes sync to the Tracker.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</label>
                <div className="flex flex-wrap gap-1.5">
                  {STATUS_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setStatus(opt.key)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                        status === opt.key
                          ? 'border-ring bg-accent text-accent-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent/50'
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', opt.dotClass)} />
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Recruiter name
                  </label>
                  <input
                    value={recruiterName}
                    onChange={(e) => setRecruiterName(e.target.value)}
                    placeholder="Jane Doe"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Recruiter contact
                  </label>
                  <input
                    value={recruiterContact}
                    onChange={(e) => setRecruiterContact(e.target.value)}
                    placeholder="email or LinkedIn URL"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Next follow-up
                </label>
                <input
                  type="date"
                  value={nextFollowUp}
                  onChange={(e) => setNextFollowUp(e.target.value)}
                  className="flex h-9 w-44 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <p className="mt-1 text-xs text-muted-foreground">Will surface in Tracker · &quot;Needs follow-up&quot; section.</p>
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Interview prep, learnings, blockers..."
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>

              <div className="flex items-center gap-3">
                <Button onClick={saveOutcome} size="sm">
                  <Save className="h-3.5 w-3.5" />
                  Save
                </Button>
                {saved && (
                  <span className="flex items-center gap-1 text-sm text-success">
                    <Check className="h-3.5 w-3.5" />
                    Saved
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

        </>
      )}
    </div>
  );
}

