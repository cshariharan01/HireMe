# HireSignal Personal Edition v0.1.0

> **Historical note (added at v1.0.0).** This page is kept as the record of what was released at
> the time. Its "one-click apply" / "auto-apply via official APIs" claim turned out to be wrong:
> no job board accepts applicant submissions (Greenhouse requires an employer key, Ashby moved
> behind reCAPTCHA), and `apply_audit` had recorded zero successes since inception. From v1.0.0 the
> app fills the real form and you press Submit. See [RELEASE-v1.0.0.md](RELEASE-v1.0.0.md) §3.

> **Your private, local job-search engine for technical roles** — semantic résumé matching, AI
> fit-scoring, company due-diligence, and one-click apply. Runs on your machine, for free.

First public release. HireSignal is a **single-user, localhost** tool for **software / engineering /
architecture / data / DevOps** roles. It pulls jobs from ATS APIs, job boards, and company career
pages, matches them to your résumé by *meaning* (vector search), keeps the list fresh (dead/expired
jobs auto-retired), AI-rates the best fits, and can auto-apply to Greenhouse/Ashby — all on your
machine. Non-technical postings (sales, marketing, recruiting, HR) are filtered out or down-ranked.

## Highlights

- 🔎 **Semantic matching** — ranks every job against your résumé by meaning, not keywords, with soft
  signals for domain fit, target roles, location, freshness, and AI rating.
- 🧠 **AI evaluation & company briefs** — per-job fit scoring plus recession-resilience company
  due-diligence (financials, layoffs, culture, legitimacy); Levels.fyi + AmbitionBox where available.
- 🗂️ **Multi-résumé library, adaptive roles, and focus areas** — auto-derived from your résumé, all
  editable.
- 📮 **Auto-apply** — Greenhouse/Ashby via their official APIs; everything else opens a real browser
  and hands off to you to review and click Submit (zero unwanted submissions).
- 🔒 **Local & private** — one SQLite file on your machine; no accounts, no cloud storage.
- 🔌 **Bring any LLM** — Ollama (free/local) by default; or Gemini, OpenAI, Groq, Anthropic, etc.
  Embeddings can be local **or** cloud, so you can run **without Ollama** entirely.

## Prerequisites

- Node.js 18+ (tested on 20/24)
- An **embedding source** — either local **Ollama** (`ollama pull nomic-embed-text`; free, CPU-only,
  no GPU) **or** a cloud key (set `EMBEDDING_PROVIDER=gemini|openai` + `EMBEDDING_API_KEY`).

## Quick start

```bash
npm install
cp .env.example .env.local     # optional: set a chat/embedding provider
ollama serve                   # if using local Ollama
npm run dev                    # http://localhost:3000
```

Then: upload your résumé on **/profile** → run a **Full sync** from the sidebar → view your matches.

## ⏱️ Heads-up: the first sync takes a while

The first Full sync can run **~1–3+ hours** — this is expected, not a hang. The slow step is
**embedding**: on local Ollama it's CPU-bound (~1–1.5 jobs/sec), so thousands of freshly-ingested
jobs take hours. A **cloud embedding provider is dramatically faster.** It runs in the background
with live progress in the sidebar, and later syncs only embed *new* jobs (so they're quick).

## Notes

- **Single-user by design** — no authentication. Run it for yourself; **do not** host it as a public
  multi-user service.
- **You're responsible for the Terms of Service** of every site it accesses, and for reviewing every
  auto-apply submission before it's sent.
- **Optional [Freeway](freeway.md) integration** — route *chat* through a local quota-aware gateway
  for automatic multi-provider failover (embeddings stay on Ollama or a direct key).
- Changing the embedding provider on an existing database? Use `npm run reembed` (in place, keeps
  your applications/tracker) — not `npm run db:reset`.

## License

[MIT](../LICENSE) © 2026 vinaygiri

---

**Asset:** `hiresignal-personal-v0.1.0.zip` — source only (no data, no keys). Unzip → `npm install` →
run. (Or clone the repo.)
