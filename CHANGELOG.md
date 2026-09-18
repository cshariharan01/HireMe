# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-08-30

First stable release. v0.1.x was a prototype that could not survive its own corpus: a match page
took 30-50 seconds, the score was a cosine readout that rated seven unrelated jobs at 100%, and
the apply flow claimed a capability no job board actually offers. All three are fixed and
measured, and the behaviour is now pinned by 90 tests plus a 17-check browser end-to-end driver.
See [docs/RELEASE-v1.0.0.md](docs/RELEASE-v1.0.0.md) for the before/after numbers.

### Fixed — apply flow

- **The auto-apply preview took up to 277s to open.** It generated a cover letter inline; with a
  free LLM quota exhausted that fell through to a slow provider. Generation is now opt-in
  (`generateMissing`), and the preview reads cached documents only — **247,574ms → 762ms**.
- **"Open & autofill" opened pages with no form on them.** Ashby serves a description at the job URL
  and the form at `<url>/application` (measured: 0 vs 8-16 fillable inputs). Added
  `applicationUrl()`. Aggregators that only host descriptions (Himalayas, Hirist, HN, RemoteOK,
  Remotive) now show "Apply on company site" instead of an autofill that cannot work.
- **Viewing your résumé generated a new AI variant** instead of serving the PDF you uploaded, so the
  tab sat blank for 35-70s. `resume.pdf` now resolves: explicit markdown → stored original bytes
  (`inline`, **342ms**) → a variant already cached → only then generate.
- **Selecting "AI-tailored" before the variant existed returned "Cannot render resume PDF — no
  resume markdown"** and told users with an uploaded PDF to re-upload it. Now falls back to the
  original with a warning.
- **Errors reported the wrong portal** — `strategy: 'greenhouse'` was hardcoded in three error
  returns.
- **Cover letters are now reachable on demand** via a "Write one" button, rather than being
  generated on every preview or not at all.
- **Auto-apply rate limits: the hourly cap could never fire.** The window was bounded with
  `toISOString()` ('T' separator) while `attempted_at` uses SQLite's space separator, so every row
  written on the same date sorted below the threshold. Now uses `datetime('now', ...)`.
- **The /settings provider "Test" button health-checked the wrong gateway** — `freewayHealth()`
  ignored the provider's configured `base_url`.
- **Generating a cover letter or résumé variant created a fake "applied" record.** The documents had
  nowhere else to live, so they were written into `my_applications` — the tracker counted jobs you
  had only looked at. Documents now have their own store and are promoted to an application only
  when you actually apply. (Three fabricated rows were removed; no real application was touched.)
- **A hung LLM provider pinned the whole dev server.** No fetch carried an `AbortSignal` and neither
  SDK defaults to a timeout, so one `/api/jobs/[id]/format` call wedged the process at ~940MB and
  every route 500'd until it was killed. Every provider attempt is now bounded
  (`LLM_CALL_TIMEOUT_MS`, default 120s) at the layer where a timeout **rotates** to the next
  provider instead of failing the request.

### Changed — honesty about what applying can do

- **No portal is submitted to directly, and the UI no longer claims otherwise.** Greenhouse's
  submit endpoint requires employer HTTP Basic credentials (`401`, `WWW-Authenticate: Basic
  realm="Application"` — and a POST to a nonexistent board returns the same, proving the gate is
  endpoint-wide). Ashby moved its form behind reCAPTCHA. Both direct paths are disabled behind
  flags; every posting now offers "Open & autofill" or "Apply on company site". This is why
  `apply_audit` had recorded zero successes since inception.
- **Lever and LinkedIn removed** — no submitter module ever existed for either.
- README, in-app Guide and the social banner corrected: the "one-click apply" claim is gone.

### Added — job coverage

- **14 ATS platforms, up from 6.** Added Workday, Workable, Breezy, Pinpoint, BambooHR, Personio,
  Teamtailor, Rippling and Manatal alongside Greenhouse, Lever, Ashby, SmartRecruiters and
  Recruitee. Each has both a detector and a real puller; `test/ats-coverage.test.ts` fails the build
  if a platform is ever half-wired (Workday shipped detectable with `return []`, which silently
  suppressed the crawl fallback too). Verified live, 14/14.
- **Company directory search** (`npm run sync:directory`, `/import` → "Find a company"). Searches
  ~37,000 company career boards by name and seeds or pulls one in a click. It is a *directory*, not
  a job feed — every posting is still fetched by our own adapters, so the jobs stay ours and
  current. This exists because Workday boards cannot be guessed: a pull needs tenant + data-centre
  host + site, and probing 15 plausible combinations for Kaiser, HCA, Providence, Cigna and
  Elevance found zero working boards.
- Search ranking is tiered (exact › prefix › word-start › substring) and a substring-only hit is
  badged "loose match" — a plain `LIKE` surfaced "Relevance AI" for "Elevance" and "Mayors
  Migration Council" for "Mayo", and adding the wrong company imports a whole board of noise.

### Added

- **Test suite (Vitest)** — 90 tests. `pool: 'forks'` is required for the native SQLite addons.
  Covers the two defects a 17-check browser E2E could not see, plus scoring, routing, rate limits,
  dry-run network isolation, the first-paint seed key, Workday URL parsing, ATS probe guards and
  adapter coverage.
- **[User manual](docs/USER-MANUAL.md)** — workflow, scoring model and its limits, real timings.
- `LLM_INTERACTIVE_TIMEOUT_MS` (75s) for calls a user waits on, separate from batch work.
- Local cover-letter fallback: a compact prompt (1,729 chars vs ~9-10k) makes local Ollama viable —
  **74s** for a complete 222-word letter where the full prompt never finished.

### Performance

- First paint ships data: the dashboard route is a Server Component seeding SWR — **30 rows in the
  server HTML** (was 0), first row visible **970ms**.
- Job click fires **1 request instead of 6**; hover prefetch makes a click cost **0** new fetches.
- Ranked-payload memo + id index: `/api/matches/[jobId]` no longer parses 1.6MB to read one row.
- Payload trimmed 1.91MB → 1.67MB by dropping six fields written but never read.
- Score tiers recalibrated (55/45/33): **95.1% of jobs were rendering as "low"**.
- `rolePenalty` reaches the score again; `evaluate-top` now spends LLM quota on the jobs the
  dashboard actually shows.
- Upgraded to Next 15 + React 19.


## [0.1.1] - 2026-07-19

Repository, tooling, and documentation polish (no changes to the app's functionality).

### Added
- Continuous-integration workflow (typecheck + build) and an automated GitHub Release workflow.
- Contributor scaffolding: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and issue/PR templates.
- README: table of contents, Features, and Tech stack sections; a product demo GIF and a social-preview banner.
- `docs/freeway.md` — optional guide to routing chat through a local Freeway gateway.

### Changed
- Documentation polish: clearer embedding-provider and sync-timing notes; removed a personal reference.

## [0.1.0] - 2026-07-19

First public release.

### Added
- Semantic résumé ↔ job matching (vector search with sqlite-vec) with soft re-rank signals
  (domain fit, target roles, freshness, location, AI rating).
- Per-job AI evaluation and recession-resilience company briefs.
- Freshness & validity engine — stale/delisted jobs and dead links are auto-retired.
- Auto-apply for Greenhouse/Ashby (official APIs) with a visible-browser handoff for other portals.
- Company intelligence: Levels.fyi compensation, AmbitionBox ratings, layoff history.
- Multi-résumé library with adaptive target roles and focus areas.
- Provider-aware embeddings — Ollama by default, or Gemini / OpenAI (run without Ollama).
- Provider-aware chat with an automatic fallback chain.
- In-app sync (Quick / Full / Rate) with live progress, and an in-app user guide.
- Read-through match cache and an embedding-signature guard to prevent mixed embedding spaces.
- `npm run reembed` to switch embedding provider in place without losing data.

[Unreleased]: https://github.com/vinaygiri/hiresignal-personal/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/vinaygiri/hiresignal-personal/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/vinaygiri/hiresignal-personal/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/vinaygiri/hiresignal-personal/releases/tag/v0.1.0
