import Link from 'next/link';
import {
  Sparkles, FileUp, RefreshCw, Target, User, Upload, Send, Building2, Wrench, ShieldCheck, BookOpen,
  ListFilter, Database,
} from 'lucide-react';

export const metadata = { title: 'Guide — HireSignal' };

function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 break-inside-avoid space-y-2 rounded-xl border bg-card p-5 shadow-soft">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Icon className="h-4 w-4 text-primary" /> {title}
      </h2>
      <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function GuidePage() {
  return (
    <div className="w-full space-y-6 pb-16">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <BookOpen className="h-5 w-5 text-primary" /> HireSignal — User Guide
        </h1>
        <p className="text-sm text-muted-foreground">
          A personal, private job-search tool. Everything runs on your machine — your résumé, jobs, and matches
          never leave this computer.
        </p>
      </header>

      {/* Full-width masonry of cards — fills the page like the other views instead of a narrow column. */}
      <div className="columns-1 gap-6 lg:columns-2 xl:columns-3">
      <Section icon={Sparkles} title="Getting started (first run)">
        <p>Two things are needed before matches appear:</p>
        <ol className="ml-4 list-decimal space-y-1.5">
          <li>
            <strong className="text-foreground">Upload your résumé</strong> on the{' '}
            <Link href="/profile" className="text-primary hover:underline">Profile</Link> page (PDF). It&apos;s parsed,
            embedded, and used to rank every job. You can keep several résumés and switch the active one.
          </li>
          <li>
            <strong className="text-foreground">Run a Full sync</strong> from the{' '}
            <span className="font-medium text-foreground">Sync</span> button in the sidebar. This pulls fresh jobs from
            all sources and company career pages, then embeds them. Takes a few minutes the first time.
          </li>
        </ol>
        <p>
          <strong className="text-foreground">Prerequisite — an embedding source.</strong> Matching needs embeddings.
          By default they run on local <strong className="text-foreground">Ollama</strong> (free, CPU-only) — pull{' '}
          <code className="rounded bg-muted px-1">nomic-embed-text</code> (and optionally{' '}
          <code className="rounded bg-muted px-1">llama3.2</code> for a local chat fallback). Prefer not to run Ollama?
          Point embeddings at a cloud provider instead via <code className="rounded bg-muted px-1">EMBEDDING_PROVIDER</code>{' '}
          in <code className="rounded bg-muted px-1">.env.local</code> — see <em>Providers &amp; embeddings</em> below.
        </p>
      </Section>

      <Section icon={RefreshCw} title="The Sync button — Quick / Full / Rate">
        <ul className="ml-4 list-disc space-y-1.5">
          <li><strong className="text-foreground">Quick refresh</strong> — embed new jobs, prune stale ones, verify links. No scraping, no AI. Fast.</li>
          <li><strong className="text-foreground">Full sync</strong> — everything Quick does, plus fetch new jobs from all sources and discover company career pages.</li>
          <li><strong className="text-foreground">Rate top matches</strong> — AI-scores your top matches (fit, comp, culture, strategy). Run this when your LLM quota is fresh; it&apos;s the quota-sensitive step, kept separate on purpose.</li>
        </ul>
        <p><strong className="text-foreground">⏱️ Timing:</strong> the <strong className="text-foreground">first Full sync can take ~1–3+ hours</strong> — normal, not a hang. The slow step is <strong className="text-foreground">embedding</strong> (on local Ollama it&apos;s CPU-bound, ~1–1.5 jobs/sec); a cloud embedding provider is much faster. Later syncs only embed <em>new</em> jobs, so they&apos;re far quicker.</p>
        <p>Progress (step checklist, live log, elapsed time, job counter) shows in the sidebar. You can cancel any run, and syncs keep running even if you browse around.</p>
      </Section>

      <Section icon={Target} title="How matching &amp; ranking work">
        <p>Each job gets a single <strong className="text-foreground">fit score out of 100</strong>. It combines four things, and no single one can dominate:</p>
        <ul className="ml-4 list-disc space-y-1.5">
          <li><strong className="text-foreground">Retrieval (40%)</strong> — how well the posting matches your résumé, by <em>meaning</em> (vector similarity) and by <em>wording</em> (keyword search), the two blended by rank.</li>
          <li><strong className="text-foreground">Skill overlap (25%)</strong> — your actual skills against the ones the job asks for. Skills named in the job <em>title</em> count double. This is why a Java architect role no longer scores highly if you have never written Java.</li>
          <li><strong className="text-foreground">AI rating (25%)</strong> — the 1-5 verdict from &quot;Rate top matches&quot;. Unrated jobs redistribute this weight rather than being penalised for not having been rated yet.</li>
          <li><strong className="text-foreground">Context (10%)</strong> — location fit, freshness, posting legitimacy, your focus areas and target roles.</li>
        </ul>
        <p>Your <strong className="text-foreground">career targets</strong> are hard constraints, not nudges: a deal-breaker caps the score at 15, an AI &quot;skip&quot; caps it at 45, and missing must-haves subtract. Each row shows <strong className="text-foreground">why</strong> it scored what it did — problems first, so a bad match can&apos;t look good.</p>
        <p>Duplicate postings of the same role at the same company are collapsed into one row (with a &quot;N locations&quot; chip), and no single company can take more than three of the top slots.</p>
        <p><strong className="text-foreground">Scope — technical roles.</strong> HireSignal is built for engineering/technical jobs (software, architecture, data, DevOps, …). Non-technical postings (sales, marketing, recruiting, HR) are filtered on broad sources and down-ranked elsewhere. Seniority adapts to your résumé — senior/architect roles by default, plus junior/entry-level <em>technical</em> roles if you&apos;re early-career. Within that scope nothing else is a hard filter (except dead links), so relevant roles across all industries surface, with your domain boosted.</p>
      </Section>

      <Section icon={ListFilter} title="Working the matches list">
        <ul className="ml-4 list-disc space-y-1.5">
          <li><strong className="text-foreground">Two panes</strong> — pick a job on the left; its evaluation, company brief, comp, and apply options load on the right. Heavy analysis loads only for the job you open (cached after).</li>
          <li><strong className="text-foreground">Filter &amp; sort</strong> — search box, a <strong className="text-foreground">Place</strong> dropdown (filter by city/remote), fit chips (apply/consider/skip), location and role chips, and sort by best match / rating / recency.</li>
          <li><strong className="text-foreground">Applied jobs</strong> — once you apply, the job moves out of the matches list and into <strong className="text-foreground">Tracker</strong>, so the list keeps backfilling with things you haven&apos;t acted on. They&apos;re never re-rated (that would spend AI quota on a decision you&apos;ve already made) and never deleted.</li>
          <li><strong className="text-foreground">Keyboard</strong> — <code className="rounded bg-muted px-1">j/k</code> move, <code className="rounded bg-muted px-1">e</code> open, <code className="rounded bg-muted px-1">x</code> hide, <code className="rounded bg-muted px-1">/</code> search. Save filter combos as named searches.</li>
        </ul>
      </Section>

      <Section icon={User} title="Profile — résumés, roles, focus areas">
        <ul className="ml-4 list-disc space-y-1.5">
          <li><strong className="text-foreground">Résumé library</strong> — upload multiple (e.g. one generic, one specialized), switch the active one; matches recompute.</li>
          <li><strong className="text-foreground">Target roles</strong> and <strong className="text-foreground">Focus areas</strong> — auto-derived, all editable. Use <em>Regenerate</em> to re-derive from the current résumé, then <em>Save</em>.</li>
          <li><strong className="text-foreground">Career targets</strong> — locations, compensation, must-haves. These feed evaluation, cover letters, and résumé variants.</li>
        </ul>
      </Section>

      <Section icon={Send} title="Applying to jobs">
        <p>Open a job and use the auto-apply dialog. It can send either your <strong className="text-foreground">original PDF</strong> (no AI, exactly as uploaded) or an <strong className="text-foreground">AI-tailored variant</strong> — your choice per application.</p>
        <p><strong className="text-foreground">Nothing is ever submitted on your behalf.</strong> No job board offers applicants a submission API — Greenhouse&apos;s needs an employer key and Ashby&apos;s sits behind a CAPTCHA — so the tool does the typing and you do the submitting:</p>
        <ul className="ml-4 list-disc space-y-1.5">
          <li><strong className="text-foreground">&quot;Open &amp; autofill&quot; (~96% of jobs)</strong> — opens the real application form in a browser window, fills the standard fields, attaches your résumé, and hands off to <em>you</em> to review and click Submit. It never clicks Submit itself, so an unwanted submission is impossible. It keeps watching that window and marks the application confirmed once it sees the confirmation page.</li>
          <li><strong className="text-foreground">&quot;Apply on company site&quot; (~4%)</strong> — LinkedIn, Lever, Indeed and similar. These need a login, so there&apos;s nothing honest to automate and only the plain link is shown.</li>
        </ul>
        <p>Answers to screening questions are saved and reused on later applications — review, edit or delete them under <Link href="/settings" className="text-primary hover:underline">Settings → Screening answers</Link>. Before applying, the tool re-checks the posting is still live and refuses closed/dead listings. A required question with no answer blocks the submission rather than sending an incomplete form.</p>
      </Section>

      <Section icon={Building2} title="Company intelligence">
        <p>On a job you can generate an <strong className="text-foreground">AI evaluation</strong> (fit across several dimensions) and a <strong className="text-foreground">company brief</strong> (financial resilience, layoffs, culture, legitimacy). Where available it pulls Levels.fyi comp, AmbitionBox (India) ratings, and layoff history. All cached per company.</p>
      </Section>

      <Section icon={Database} title="Providers &amp; embeddings">
        <p><strong className="text-foreground">Two independent LLM settings:</strong></p>
        <ul className="ml-4 list-disc space-y-1.5">
          <li><strong className="text-foreground">Chat</strong> (evaluations, cover letters, research) — set in <Link href="/settings" className="text-primary hover:underline">Settings</Link>. Defaults to Ollama; add Gemini (free tier), Groq, OpenAI, Anthropic, etc. It auto-rotates keys and falls back to Ollama when one is rate-limited.</li>
          <li><strong className="text-foreground">Embeddings</strong> (matching) — set via <code className="rounded bg-muted px-1">EMBEDDING_PROVIDER</code> in <code className="rounded bg-muted px-1">.env.local</code>; the active one shows on the Settings <em>Embeddings</em> card. Ollama by default (no quota); or Gemini/OpenAI to skip Ollama entirely.</li>
        </ul>
        <p><strong className="text-foreground">Switching embedding provider</strong> means re-embedding (all vectors must share one model). Run <code className="rounded bg-muted px-1">npm run reembed</code> — it re-embeds in place and keeps your applications, tracker, and résumés. The app blocks mixing embedding spaces with a clear message.</p>
        <p>Want quota-proof chat across many free providers? Route chat through <strong className="text-foreground">Freeway</strong> (optional) as an <em>openai-compatible</em> provider — see <code className="rounded bg-muted px-1">docs/freeway.md</code>.</p>
      </Section>

      <Section icon={Wrench} title="Troubleshooting">
        <ul className="ml-4 list-disc space-y-1.5">
          <li><strong className="text-foreground">Blank / no matches</strong> — do both first-run steps, and make sure your embedding source is reachable (Ollama running, or a valid cloud key).</li>
          <li><strong className="text-foreground">Résumé upload fails</strong> — the error names the embedding provider. On Ollama: start it / use <code className="rounded bg-muted px-1">127.0.0.1</code>. On a cloud key: check the key and your daily limit.</li>
          <li><strong className="text-foreground">&quot;Embedding provider mismatch&quot;</strong> — you changed <code className="rounded bg-muted px-1">EMBEDDING_PROVIDER</code> on an existing DB. Run <code className="rounded bg-muted px-1">npm run reembed</code>, or set it back.</li>
          <li><strong className="text-foreground">Rating is slow / failing</strong> — cloud chat quota is likely exhausted; it falls back to Ollama (CPU, one at a time). Add another provider in Settings, or use Freeway.</li>
          <li><strong className="text-foreground">App not running</strong> — it&apos;s manual-start: run <code className="rounded bg-muted px-1">npm run dev</code> and open localhost:3000.</li>
        </ul>
      </Section>

      <Section icon={ShieldCheck} title="Privacy">
        <p>Single-user and local by design — no accounts, no cloud storage. Your data lives in one SQLite file on this machine. The only outbound calls are to the job sources you sync and, if you configure one, your chosen LLM provider.</p>
      </Section>
      </div>

      <div className="flex flex-wrap gap-3 border-t pt-4 text-sm">
        <Link href="/profile" className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"><FileUp className="h-4 w-4" /> Go to Profile</Link>
        <Link href="/import" className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"><Upload className="h-4 w-4" /> Import / discover</Link>
        <Link href="/" className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"><Target className="h-4 w-4" /> View matches</Link>
      </div>
    </div>
  );
}
