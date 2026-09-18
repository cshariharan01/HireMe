# HireSignal — User Manual

A practical guide to running HireSignal day to day. For installation see the
[README](../README.md); for the in-app version of this, open **Guide** in the sidebar.

---

## 1. What this tool does, and what it doesn't

**It does:** pull jobs from ~13 sources, match them against your résumé, score the fit, research the
company, and fill in application forms for you.

**It does not submit applications.** No job board offers applicants a submission API — Greenhouse's
requires an employer key (it answers `401 HTTP Basic: Access denied`) and Ashby's sits behind a
CAPTCHA. So HireSignal opens the real form in a visible browser, fills what it can, and stops. You
read it and press Submit. That is deliberate: an unwanted submission is impossible.

---

## 2. First run

1. **Start Ollama** and pull both models — nothing works without them:
   ```
   ollama pull nomic-embed-text     # matching (required, always local)
   ollama pull llama3.2             # local fallback for text generation
   ```
2. `npm run dev`, open <http://localhost:3000>.
3. **Profile → upload your résumé (PDF).** This drives everything. It also stores the original PDF
   bytes, which is what gets attached to applications by default.
4. Review the **target roles** and **focus areas** it derived. Deselect anything you don't want to
   be hunted for — these feed the job-search queries.
5. **Career targets** — locations, minimum compensation, must-haves, deal-breakers. These are *hard
   constraints* at ranking time, not hints: a deal-breaker caps a job's score at 15.
6. Run a **Full sync** from the sidebar.

### How long the first sync takes

Embedding is the bottleneck and it is CPU-bound on local Ollama — measured **2.2 seconds per job**
on a typical posting:

| jobs | time |
|---|---|
| 1,000 | ~37 min |
| 5,000 | ~3.1 h |
| 10,000 | ~6.2 h |

Later syncs only embed *new* jobs, so they are far quicker. The sync runs in a detached process —
you can browse, close the tab, or restart the dev server without losing it.

---

## 3. Daily use

| Task | Where |
|---|---|
| Review matches | **Matches** (the dashboard) |
| Read a posting | Click a row → **Description** tab |
| See why it scored that | the chips next to the score, on the row and in the header |
| AI verdict | **AI review** tab (needs a rating — see §5) |
| Company due diligence | **Company** tab (layoffs, comp, Ambitionbox, brief) |
| Apply | **Apply & track** tab |
| Track applications | **Tracker** |

**Keyboard:** `j`/`k` move · `e` open · `x` hide · `/` search · `[`/`]` prev/next job.

Filters, sort and saved searches run **server-side across the whole ranked pool**, so the chip
counts reflect what actually exists, not just the rows on screen.

---

## 4. Understanding the fit score

One number out of 100, combining four things:

| component | weight | what it measures |
|---|---|---|
| Retrieval | 40% | meaning (vector) + wording (keyword), blended by rank |
| **Skill overlap** | **25%** | your skills vs. what the job asks for; title skills count double |
| AI rating | 25% | the 1–5 verdict, when the job has been rated |
| Context | 10% | location, freshness, legitimacy, focus areas, target roles |

Unrated jobs redistribute the AI weight rather than being penalised for not being rated yet.

**Tier colours** are calibrated to the real distribution: **≥55 high · ≥45 good · ≥33 fair**. A
median job scores ~32, so "fair" is genuinely mid-pack, not a failure.

### One limitation, stated plainly

Context is 10% of the score *and* is bounded, so several things you configure by hand —
**target roles, focus areas, location preference** — are worth roughly **one point each**. They act
as tie-breakers, not preferences. Deal-breakers and must-haves are the levers that really move
ranking.

---

## 5. Ratings and company briefs (the parts that need an LLM)

Everything else is local. These two call a cloud model:

- **Rate top matches** (sidebar, or `npm run evaluate:top`) — scores your top matches 1–5 and
  writes an `apply`/`consider`/`skip` recommendation.
- **Company brief** — opens on the Company tab, cached per company.

**Timing:** ~5s per job on Gemini Flash with quota available; ~33s per job via the Freeway gateway.
30 jobs ≈ 3 min on Gemini, ≈ 19 min on Freeway.

**When free quota runs out** (Gemini's daily limit is the usual one), ratings stop until it resets.
Two options:

1. **Wait.** Ratings are cached — you never pay twice for the same job.
2. **Run them locally.** Set `OLLAMA_CHAT_FALLBACK=1` in `.env.local` to put Ollama in the chat
   chain. It always works and costs nothing, but `llama3.2` is a much weaker judge than a hosted
   model — treat its ratings as a rough sort, not a verdict. This is off by default for that reason.

Matching itself is **never** blocked by quota: embeddings always run on local Ollama.

---

## 6. Applying to a job

Open a job → **Apply & track**. What you're offered depends on what the portal actually permits:

- **"Open & autofill"** (~77% of jobs) — a visible browser opens the real form with your details,
  résumé and cover letter filled in. Review it, answer anything custom, click **Submit** yourself.
  HireSignal keeps watching that window and marks the application confirmed when it sees the
  confirmation page. If it can't detect one it records *"confirmation not detected"* rather than
  claiming success — check your email in that case.
- **"Apply on company site"** (~23%) — LinkedIn, Lever, Indeed, and aggregator pages that only host
  a description. There is no form to fill, so only the link is shown.

### Résumé: original vs AI-tailored

Default is your **uploaded PDF**, unchanged — no AI involved. Switch to **AI-tailored** in the
dialog or in Settings if you want a variant rewritten for that posting. The tailored version is
generated when you submit, not when you preview, so the dialog stays fast.

### Cover letter

Optional. Click **"Write one"** in the dialog when you want it — it is *not* generated automatically,
because that used to make opening the dialog take minutes. Expect **~30s** on Gemini, **~50–75s**
if it falls back to local Ollama.

### Screening answers

Answers are saved and **reused on every future application that asks the same question**. Review
them under **Settings → Screening answers** — especially the work-authorisation and sponsorship
ones, where a wrong saved answer would propagate silently. Edit corrects it everywhere; delete makes
it ask fresh next time.

### Safety rails

- **Dry-run** (Settings → Auto-apply) builds the whole submission and never touches the network.
- **Rate limits** — per-day and per-hour caps on submissions.
- A **required question with no answer blocks** the submission instead of sending an incomplete form.
- Before applying, the posting is re-checked live and refused if it's closed or dead.

---

## 6a. Adding companies you care about

`npm run discover` pulls **whole job boards** for the companies in `scripts/data/companies.txt`.
Add a company two ways:

**By name** — the tool probes **14 ATS platforms**, so most companies just work:

| | |
|---|---|
| Greenhouse · Lever · Ashby | SmartRecruiters · Recruitee · Workable |
| Breezy HR · Pinpoint · BambooHR | Personio · Teamtailor · Rippling |
| Manatal | Workday *(URL only — see below)* |

Each was verified end-to-end against a real live board before being included.

**By search (easiest)** — run `npm run sync:directory` once (~7MB), then go to **Import → Find a
company**, type a name, and click **Add & pull**. That searches ~37,000 company career boards that
each arrive *with* their board URL, so there is no careers-URL hunting at all. It seeds the company
for future syncs and can pull the whole board immediately.

Watch the match badge: a result tagged **loose match** is a guess, not a hit — searching "Elevance"
also surfaces "Relevance AI".

**By URL** — required for **Workday**, which is what most large US health systems, payers and EHR
vendors use (Kaiser, Optum, HCA, Providence, Mayo, Cigna, Elevance, Epic, Cerner…). A Workday pull
needs the tenant, data-centre host and site name, and none can be guessed from a company name. So:

1. Google "*company* careers", click into their job board.
2. If the address bar shows `something.wdNN.myworkdayjobs.com/SomeSite`, paste that URL into
   `companies.txt`.
3. Re-run `npm run discover`.

Anything else falls back to a heuristic page crawl. Be aware it recovers only a couple of postings
at best on big corporate sites — those pages are built for humans, not machines. When it can't find
anything plausible it logs *"careers site is not machine-readable"* and skips, rather than importing
navigation links as jobs.

---

## 7. Keeping the list fresh

`npm run daily` runs the whole loop: ingest → discover → embed → prune → verify links → rate.

- **prune** retires postings that vanished from their source, are older than `MAX_POST_AGE_DAYS`
  (180), or whose links are dead. It has a **mass-expiry guard**: if the rules would retire more
  than 40% of your active corpus it refuses and exits, because that means ingest didn't run.
- **verify:links** HTTP-checks your top matches and expires dead ones.
- Applied jobs leave the matches list and live in **Tracker**. They're never re-rated and never
  deleted.

---

## 8. Settings reference

| Section | What it controls |
|---|---|
| LLM Providers | Add/activate Gemini, OpenAI, Anthropic, Groq, Freeway, Ollama. **Test** pings the one you configured. One active at a time; others become fallbacks. |
| Embeddings | Shows the active embedding model and warns if vectors were built with a different one. |
| Auto-apply | Portal toggles, per-day/per-hour caps, résumé source, dry-run. |
| Screening answers | Review, edit, delete reused answers. |

**Provider order:** active row → your other keys → Freeway → Ollama (last, and only if opted in).
A 429 puts a provider on cooldown (6h daily / 90s per-minute); a retired model parks it for 7 days.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Résumé upload fails | Ollama not running, or `nomic-embed-text` not pulled. The error says which. |
| "Cover letter failed" | All providers exhausted. Wait for quota, or set `OLLAMA_CHAT_FALLBACK=1`. The letter is optional — you can apply without it. |
| Autofill window opens with nothing filled | That page has no application form (usually an aggregator). Use "Apply on company site". |
| Matches list is empty after a Quick sync | Quick doesn't ingest. Run a Full sync. |
| Ratings all missing | Free quota exhausted, or `evaluate:top` hasn't run. See §5. |
| Everything is grey / low tier | You're looking at a filtered view of the tail. Median is ~32 by design. |
| Sync seems stuck on "embed" | It isn't — see the timings in §2. The log line and job counter update as it goes. |

**Logs:** the sidebar sync panel shows a live log line. Server logs go to the terminal running
`npm run dev`.

---

## 10. Privacy

Everything is local: SQLite at `data/hiresignal.db`, embeddings via local Ollama, no telemetry.
The only outbound traffic is (a) job boards you ingest from, (b) whichever LLM provider you
configure for ratings, (c) the application form you submit yourself, and (d) the one-off company
directory download, if you run `npm run sync:directory`. None of them is sent anything about you:
the directory is a plain CSV fetch, and ingestion only reads public listings.

`.gitignore` already excludes your database, résumé PDFs, `.env.local` and local notes — but check
before pushing to a public remote.
