# HireSignal Personal Edition v1.0.0

> **Your private, local job-search engine for technical roles** — semantic résumé matching, AI
> fit-scoring, company due-diligence, and assisted apply. Runs on your machine, for free.

**First stable release.** v0.1.x was a working prototype that could not survive its own corpus;
1.0.0 is the version that is actually usable every day — and the first one whose behaviour is pinned
by a test suite (90 unit and regression tests, plus a 17-check browser end-to-end driver) rather
than by hope.

Three things changed: the app got fast, the scoring became a real fit score instead of a
cosine-similarity readout, and the apply flow stopped claiming to do something it could not do.

Every number below was measured on a real corpus of **16,282 postings (8,099 active)**, not
estimated.

---

## 1. It is fast now

The prototype was unusable at corpus scale — a match page took 30–50 seconds because every request
recomputed the whole ranking, and a running embed job invalidated the cache on every batch.

| | before | after |
|---|---|---|
| Match page load | 30–50 s | **146 ms** |
| First paint | 0 rows (skeleton) | **30 rows in the server HTML**, first row at 970 ms |
| Clicking a job | 6 requests / 1.2 s | **1 request / 227 ms** (0 on hover-prefetch) |
| Opening the apply dialog | 247,574 ms | **762 ms** |
| Viewing your résumé | blank tab, 35–70 s | **342 ms** |
| Cover letter | 233 s, usually failed | **29–50 s** |

What actually fixed it: a per-job skill cache (`job_skills`), stale-while-revalidate on the ranked
payload with the refresh in a **detached process** (better-sqlite3 is synchronous, so an in-process
"background" recompute blocks every other request), a memoised payload keyed by cache signature, and
the dashboard becoming a Server Component that seeds SWR.

The match list is deliberately **not** virtualized — measured first: typing latency is flat with row
count (161 ms at 30 rows, 168 ms at 210), and virtualizing would have broken `j`/`k` navigation for
no gain. The rows use `content-visibility: auto` instead.

## 2. The fit score is a fit score

The old model summed seven unbounded signals on top of a raw cosine. Because `nomic-embed-text`
spans only ~0.29–0.83 over this corpus, **everything plausible read 70–99%**, the sum exceeded 1.0
and clamped, so seven unrelated jobs all displayed "100%" — and nothing compared your skills to the
job's. A *Java Solution Architect* scored 98% for a candidate with no Java.

Now:

- **Hybrid retrieval** — vector search *and* BM25 over an FTS5 index, fused with Reciprocal Rank
  Fusion. RRF compares ranks, never raw scores, because a 0.78 cosine and a −25.7 BM25 are on
  unrelated scales.
- **A bounded composite** — retrieval 40% · skill overlap 25% · AI rating 25% · context 10%.
  Unrated jobs redistribute the AI weight rather than being structurally capped.
- **Skill fit** — the signal that simply did not exist. Word-boundary matching against a canonical
  vocabulary, so `Java` no longer matches `JavaScript`. Title requirements count double.
- **Hard constraints are honoured.** Your must-haves, deal-breakers, minimum comp and locations were
  written by `/profile` and then ignored at ranking time. A deal-breaker now caps a score at 15.
- **"Why matched" chips** on every row, negatives first.
- **Tiers recalibrated** to the real distribution: **95.1% of jobs used to render as "low"**, which
  made every filtered view a wall of grey. Now roughly 5 / 10 / 33 / 52%.
- Duplicate company+title rows are collapsed at read time (19% of the corpus) and capped at three
  rows per company; applied jobs leave the list and live in the Tracker.

Ratings coverage went from **4 of the top 30 rated to 28–29 of 30**, because `evaluate-top` now
ranks with the same engine the dashboard uses — it used to spend LLM quota on a completely different
set of jobs.

## 3. Honest apply

**No job board offers applicants a submission API, and the UI no longer pretends otherwise.**

- Greenhouse's submit endpoint requires employer HTTP Basic credentials — it answers `401
  HTTP Basic: Access denied`, and a POST to a *nonexistent* board returns the same, which proves the
  gate sits on the endpoint before any board lookup. GET is public, which is why plan-building and
  dry-runs always looked healthy while submission was structurally impossible. This is why
  `apply_audit` had recorded **zero successes since inception**.
- Ashby moved its form behind reCAPTCHA — verified across six company boards.
- **Lever and LinkedIn were removed**, not deferred: no submitter module ever existed for either.

So every posting now offers one of two honest actions: **Open & autofill** (a visible browser fills
the real form; *you* read it and press Submit) or **Apply on company site**. An unwanted submission
is impossible by construction.

Also fixed here: the résumé attached is your **original uploaded PDF** by default (the AI-tailored
variant is a toggle); generating a cover letter no longer fabricates an "applied" record in your
tracker; required-but-unanswered screening questions block submission instead of being silently
dropped; and stored screening answers finally have a UI in **Settings**.

## 4. Far more jobs, from far more places

- **14 ATS platforms, up from 6** — added Workday, Workable, Breezy, Pinpoint, BambooHR, Personio,
  Teamtailor, Rippling and Manatal. Each has a detector *and* a real puller, verified live 14/14, and
  a test fails the build if one is ever half-wired.
- **Company directory search** — `npm run sync:directory` (a one-time ~7 MB CSV), then **Import →
  Find a company**: type a name, click **Add & pull**. It searches **~37,000 company career boards**
  that each arrive *with* their board URL.

  This exists because Workday boards cannot be guessed — a pull needs tenant + data-centre host +
  site, and probing 15 plausible combinations for Kaiser, HCA, Providence, Cigna and Elevance found
  zero working boards. Workday is what most large US health systems, payers and EHR vendors use, so
  without this the biggest employers were simply unreachable.

  It is a **directory, not a job feed**: every posting is still pulled fresh by HireSignal's own
  adapters, so the jobs stay ours and current. Only the company→ATS mapping comes from outside, and
  that changes maybe once in years.
- Search results are ranked exact › prefix › word-start › substring, and a substring-only hit is
  badged **loose match** — a plain `LIKE` surfaced "Relevance AI" for "Elevance".
- Full sync is a **concurrency pool** rather than eleven chained commands, so wall-clock is the
  slowest source instead of the sum, and one blocked scraper no longer kills every source after it.
  Career-page discovery went from 27–107 min to **82 s cold / 35 s warm**.

## 5. Stability

- **A hung LLM provider used to pin the entire dev server.** No fetch carried an `AbortSignal` and
  neither SDK defaults to a timeout, so one call wedged the process at ~940 MB and every route
  500'd until it was killed. Every provider attempt is now bounded, at the layer where a timeout
  **rotates to the next provider** instead of failing your request.
- **A test suite** — 90 Vitest tests across 13 files, plus a 17-check browser E2E driver. It exists
  because a code review found two defects on the primary user path that the browser E2E could not
  see.
- **Upgraded to Next 15 + React 19.**
- Prune has a mass-expiry guard: if the age rules would retire more than 40% of your active corpus
  it refuses, because that means ingest did not run.

---

## Upgrading from 0.1.x

```bash
npm install
npm run dev
```

Your database is migrated in place on first load — no reset needed. Two optional one-time steps:

```bash
npm run sync:directory   # ~7MB, enables Import -> "Find a company"
npm run embed            # embeds anything ingested but not yet matchable
```

The scoring model changed, so **your scores will move** — that is the point of §2. The score cache
is versioned and busts itself.

## Quick start (new install)

```bash
npm install
cp .env.example .env.local     # optional: set a chat/embedding provider
ollama serve                   # if using local Ollama
npm run dev                    # http://localhost:3000
```

Then: upload your résumé on **/profile** → run a **Full sync** from the sidebar → view your matches.

**Prerequisites:** Node.js 18+ (tested on 20/24), and an embedding source — local **Ollama**
(`ollama pull nomic-embed-text`; free, CPU-only) or a cloud key.

## ⏱️ The first sync still takes a while

Embedding is CPU-bound on local Ollama and Ollama serialises requests — roughly **2.2 s per job**,
so ~37 min per 1,000 jobs. That is expected, not a hang. It runs detached with live progress, and
later syncs only embed *new* jobs.

## Notes

- **Single-user by design** — no authentication; don't host it as a public multi-user service.
- **You are responsible** for the Terms of Service of every site it accesses, and for reading every
  application form before you press Submit.
- Everything stays local: SQLite on disk, embeddings on local Ollama, no telemetry. See
  [the user manual](USER-MANUAL.md) §10.

## Full detail

[CHANGELOG.md](../CHANGELOG.md) · [User manual](USER-MANUAL.md) · [README](../README.md)

## License

[MIT](../LICENSE) © 2026 vinaygiri
