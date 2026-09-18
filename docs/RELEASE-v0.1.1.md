# HireSignal Personal Edition v0.1.1

> **Historical note (added at v1.0.0).** This page is kept as the record of what was released at
> the time. Its "one-click apply" / "auto-apply via official APIs" claim turned out to be wrong:
> no job board accepts applicant submissions (Greenhouse requires an employer key, Ashby moved
> behind reCAPTCHA), and `apply_audit` had recorded zero successes since inception. From v1.0.0 the
> app fills the real form and you press Submit. See [RELEASE-v1.0.0.md](RELEASE-v1.0.0.md) §3.

> **Your private, local job-search engine for technical roles** — semantic résumé matching, AI
> fit-scoring, company due-diligence, and one-click apply. Runs on your machine, for free.

This is a **repository, tooling, and documentation** release — no changes to the app's behavior
since v0.1.0. It's the first release with an automatically-built, downloadable source zip.

## What's new in 0.1.1

- **CI + automated releases** — every push is typechecked and built; tagging a version publishes a
  Release with a source zip automatically.
- **Contributor scaffolding** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and
  issue/PR templates.
- **Standardized README** — table of contents, Features and Tech-stack sections, a product demo
  GIF, and a social-preview banner.
- **Docs polish** — clearer embedding-provider and sync-timing guidance; an optional Freeway guide.

## About HireSignal

A single-user, localhost tool for **software / engineering / architecture / data / DevOps** roles.
It pulls jobs from ATS APIs, job boards, and company career pages, matches them to your résumé by
*meaning* (vector search), AI-rates the best fits, does company due-diligence, and can auto-apply to
Greenhouse/Ashby — all on your machine. Non-technical postings are filtered out or down-ranked.

## Prerequisites

- Node.js 18+
- An **embedding source** — local **Ollama** (`ollama pull nomic-embed-text`; free, CPU-only) **or**
  a cloud key (`EMBEDDING_PROVIDER=gemini|openai` + `EMBEDDING_API_KEY`).

## Quick start

```bash
npm install
cp .env.example .env.local     # optional: set a chat/embedding provider
ollama serve                   # if using local Ollama
npm run dev                    # http://localhost:3000
```

Then: upload your résumé on **/profile** → run a **Full sync** from the sidebar → view your matches.

## ⏱️ Heads-up: the first sync takes a while

The first Full sync can run **~1–3+ hours** (CPU embedding on Ollama; cloud embeddings are far
faster) — expected, not a hang. It runs in the background with live progress, and later syncs only
embed *new* jobs.

## Notes

- **Single-user by design** — no authentication; don't host it as a public multi-user service.
- **You're responsible** for the Terms of Service of every site it accesses, and for reviewing every
  auto-apply submission before it's sent.

## License

[MIT](../LICENSE) © 2026 vinaygiri
