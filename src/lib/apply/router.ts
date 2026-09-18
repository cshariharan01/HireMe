// Auto-apply URL → strategy router.
//
// Given a job posting's URL, decide how (or whether) we can help submit it:
//   greenhouse — DISABLED: the submit endpoint needs employer HTTP Basic credentials; routes to `browser`
//   ashby      — DISABLED upstream (see ASHBY_DIRECT_SUBMIT_AVAILABLE); routes to `browser`
//   linkedin   — LinkedIn Easy Apply adapter (`src/lib/apply/linkedin.ts`): opens the Easy Apply
//                modal, fills standard fields, attaches the tailored resume, and STOPS for review.
//                Never clicks the final Submit.
//   naukri     — Naukri chatbot adapter (`src/lib/apply/naukri.ts`): handles the chatbot question
//                flow, attaches the tailored resume, and STOPS before the final Submit.
//   browser    — ASSISTS ONLY: opens a visible Playwright window, autofills the standard fields
//                and attaches the resume; the USER clicks Submit. It never clicks Submit itself.
//   manual     — we cannot help beyond the "Apply on company site" link.
//
// WHAT CHANGED AND WHY: this used to advertise `lever` and `linkedin` strategies. Neither module
// was ever written — there is no `lever.ts` and there was no `linkedin.ts` — so those URLs routed
// to a 501 branch after the UI had already shown an Auto-apply button, run a live URL check and
// spun. The doc comment above them described software that did not exist. They were `manual`, which
// was the truth, and the UI rendered "Apply on company site" for them instead of a button that
// cannot work. `apply_audit` confirms the history: 7 attempts all-time, zero successes, none of
// them lever or linkedin. Now `linkedin.ts` and `naukri.ts` exist as stop-before-submit adapters (a
// `platform.ts` type drive them — see below); `lever` remains `manual` because no submitter module
// was ever written for it.

export type SubmissionStrategy = 'greenhouse' | 'ashby' | 'linkedin' | 'naukri' | 'browser' | 'manual';

export interface StrategyMatch {
  strategy: SubmissionStrategy;
  // Strategy-specific identifiers parsed from the URL. The submitter modules
  // pull what they need from this discriminated union.
  greenhouse?: { boardSlug: string; jobId: string };
  ashby?: { company: string; jobPostingId: string };
  linkedin?: { jobId: string };
  naukri?: {};
  // 'browser' has no identifiers — we just open the URL as-is and autofill heuristically.
}

const GREENHOUSE_RE = /boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i;
// Greenhouse also self-hosts under company subdomains (e.g. boards.greenhouse.io is the canonical
// embed, but some pages link to boards.eu.greenhouse.io or job-boards.greenhouse.io).
const GREENHOUSE_ALT_RE = /(?:job-boards|boards(?:\.[a-z]{2})?)\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i;

// Ashby has two URL shapes:
//   1. jobs.ashbyhq.com/<company>/<jobPostingId>           (legacy embed)
//   2. <company>.ashbyhq.com/<jobPostingId>                (company-branded)
//   3. jobs.ashbyhq.com/<company>?ashby_jid=<jobPostingId> (rarer, query-param form)
const ASHBY_PATH_RE = /(?:^|\/\/)([a-z0-9-]+)\.ashbyhq\.com\/([a-f0-9-]{36}|[a-zA-Z0-9-]+)(?:\/|\?|$)/i;
const ASHBY_JOBS_RE = /jobs\.ashbyhq\.com\/([^/?]+)\/([a-f0-9-]{36}|[a-zA-Z0-9-]+)(?:\/|\?|$)/i;
const ASHBY_JID_RE = /jobs\.ashbyhq\.com\/([^/?]+)\?[^#]*ashby_jid=([a-f0-9-]{36})/i;

// Portals we know we CANNOT submit to. Matching them explicitly (rather than letting them fall
// through to `browser`) matters: the generic autofill assistant cannot get through a login wall or
// a multi-step Easy Apply modal, so offering it would waste the user's time and end in a dead
// visible browser window. Saying "apply on the company site" up front is the honest answer.
//
// NOTE: linkedin.com/jobs and naukri.com are intentionally NOT in this list anymore — they have
// dedicated adapters (`linkedin.ts`, `naukri.ts`) with their own detection logic, and were moved
// to their own branches in `identifySubmissionStrategy` before this list is consulted.
const NO_ASSIST_RE = [
  /jobs\.lever\.co/i,         // no submitter module was ever written for Lever
  /indeed\.com/i,             // aggressive bot detection
  /glassdoor\.com/i,
];

/**
 * Greenhouse direct submission is OFF because the endpoint requires EMPLOYER credentials.
 *
 * `submitGreenhouse` POSTs to `boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>` with no
 * Authorization header. Measured 2026-08-29 against four live boards (postman, coherehealth,
 * komodohealth, razorpaysoftwareprivatelimited): every POST returns
 *
 *     HTTP 401  "HTTP Basic: Access denied."   WWW-Authenticate: Basic realm="Application"
 *
 * A POST to a board slug that DOES NOT EXIST returns the same 401, which proves the auth gate is on
 * the endpoint itself and is evaluated before any board or job lookup — it is not a per-board
 * setting we might find an exception to. The credential is a Job Board API key issued to the
 * EMPLOYER; an applicant cannot obtain one. Reading is unaffected: GET on the same board returns
 * 63 jobs and a job's 7 questions without any auth, which is why plan-building and dry-run work
 * perfectly while submission could never succeed.
 *
 * This is exactly why `apply_audit` recorded 0 successes across its entire history: the one
 * "really submits" path in the app was structurally incapable of submitting. Greenhouse URLs now
 * route to `browser`, which opens the real hosted form, fills it, and lets the user submit — the
 * same flow a human uses, and the only one that works.
 *
 * `greenhouse.ts` is KEPT (its plan-building and question-answering are correct and are what the
 * autofill path relies on). Flip this to true only if an applicant-usable submission API appears.
 */
const GREENHOUSE_DIRECT_SUBMIT_AVAILABLE = false;

/**
 * Ashby direct submission is OFF because Ashby changed their platform.
 *
 * `ashby.ts` reads the application form schema out of the server-rendered HTML by looking for an
 * inlined `"sections":[...]` blob. That blob no longer exists: the page now ships only
 * `window.__appData` (org + posting metadata) and loads the form client-side. Measured 2026-08-29
 * across six DIFFERENT company boards (Nabla, Grow Therapy, insitro, Headway, Commure, Render):
 * 6/6 had no inlined schema and 6/6 now carry a reCAPTCHA site key. So `prepareSubmission` fails
 * with "Could not fetch Ashby application page" for every Ashby job — about 18% of the active
 * corpus — and the submission itself is now CAPTCHA-gated, which we will not work around.
 *
 * Ashby URLs therefore route to `browser`: we open the real form, fill what we can, and the user
 * reviews, solves any challenge, and submits. That is honest and it actually works.
 *
 * `ashby.ts` is kept (not deleted) because it is correct code for the old shape — if Ashby restores
 * server-rendered forms, flipping this flag re-enables the path. Nothing else references it while
 * this is false.
 */
const ASHBY_DIRECT_SUBMIT_AVAILABLE = false;


/**
 * Map a job URL to the page that actually contains the APPLICATION FORM.
 *
 * Several boards serve a description page at the job URL and put the form on a sub-path. The
 * autofill assistant was navigating to the job URL, finding nothing fillable, and leaving the user
 * staring at a browser window that looked broken. Measured on live Ashby postings:
 *
 *     https://jobs.ashbyhq.com/<co>/<id>                ->  0 fillable inputs
 *     https://jobs.ashbyhq.com/<co>/<id>/application    -> 8-16 fillable inputs
 *
 * Greenhouse's `job-boards.greenhouse.io/<board>/jobs/<id>` already renders the form inline
 * (measured 47-54 inputs), so it is left alone.
 */
export function applicationUrl(url: string): string {
  if (!url) return url;
  const bare = url.replace(/\/+$/, '');

  // Ashby — the form is always at /application, and the description page never has one.
  if (/ashbyhq\.com\//i.test(bare) && !/\/application(\?|#|$)/i.test(bare)) {
    // Preserve any query string (e.g. ?ashby_jid=…) by inserting the segment before it.
    // NB: no `s` flag — tsconfig targets ES2017, where dotAll is not available.
    const q = bare.indexOf('?');
    const path = (q === -1 ? bare : bare.slice(0, q)).replace(/\/+$/, '');
    const query = q === -1 ? '' : bare.slice(q);
    return `${path}/application${query}`;
  }

  return url;
}

/**
 * Boards that only ever show a job DESCRIPTION and hand off elsewhere to apply.
 *
 * Sampling live pages found no fillable form on any of them (himalayas 0/4, hirist 0 inputs,
 * Indeed 0). Sending the autofill assistant there produces an empty browser window and a
 * "nothing could be filled" error, which reads as a broken feature rather than an honest
 * "this board doesn't host the application".
 */
const DESCRIPTION_ONLY_RE = [
  /himalayas\.app\//i,
  /hirist\.(tech|com)\//i,
  /news\.ycombinator\.com\//i,
  /remoteok\.(io|com)\//i,
  /remotive\.(io|com)\//i,
];

export function identifySubmissionStrategy(url: string): StrategyMatch {
  if (!url) return { strategy: 'manual' };

  // LinkedIn — Easy Apply adapter. Both /jobs/view/<id> and /jobs/collections URLs route here;
  // the adapter detects Easy Apply vs. external at runtime and stops before submitting.
  // Only job URLs are routed to the adapter — generic linkedin.com/* pages are not apply flows.
  const linkedinJob = /linkedin\.com\/jobs\/(?:view\/)?(\d+)/i.exec(url) || /linkedin\.com\/jobs\/view\/(\d+)/i.exec(url);
  if (linkedinJob) {
    return { strategy: 'linkedin', linkedin: { jobId: linkedinJob[1] } };
  }

  // Naukri — chatbot adapter. Job URLs look like naukri.com/job/..., naukri.com/jobs/...
  // (older format) or naukri.com/job-listings-<slug>-<id> (current format, no trailing slash).
  const naukriJob = /naukri\.com\/(?:job-listings|jobs?\/)/i.test(url);
  if (naukriJob) {
    return { strategy: 'naukri', naukri: {} };
  }

  // Greenhouse — DIRECT SUBMIT IS DISABLED. See GREENHOUSE_DIRECT_SUBMIT_AVAILABLE below.
  const ghCanonical = GREENHOUSE_RE.exec(url);
  const ghAlt = GREENHOUSE_ALT_RE.exec(url);
  const gh =
    (ghCanonical && { boardSlug: ghCanonical[1], jobId: ghCanonical[2] }) ||
    (ghAlt && { boardSlug: ghAlt[1], jobId: ghAlt[2] });
  if (gh) {
    return GREENHOUSE_DIRECT_SUBMIT_AVAILABLE
      ? { strategy: 'greenhouse', greenhouse: gh }
      : { strategy: 'browser' };
  }

  // Ashby — DIRECT SUBMIT IS DISABLED. See ASHBY_DIRECT_SUBMIT_AVAILABLE below.
  // The URL is still parsed so the identifiers are available if the path is ever re-enabled.
  const ashJid = ASHBY_JID_RE.exec(url);
  const ashJobs = ASHBY_JOBS_RE.exec(url);
  const ashPath = ASHBY_PATH_RE.exec(url);
  const ashby =
    (ashJid && { company: ashJid[1], jobPostingId: ashJid[2] }) ||
    (ashJobs && { company: ashJobs[1], jobPostingId: ashJobs[2] }) ||
    (ashPath && ashPath[1] !== 'jobs' ? { company: ashPath[1], jobPostingId: ashPath[2] } : null);
  if (ashby) {
    return ASHBY_DIRECT_SUBMIT_AVAILABLE
      ? { strategy: 'ashby', ashby }
      : { strategy: 'browser' };
  }

  if (NO_ASSIST_RE.some((re) => re.test(url))) return { strategy: 'manual' };
  // Aggregators that only host a description — autofill has nothing to fill there.
  if (DESCRIPTION_ONLY_RE.some((re) => re.test(url))) return { strategy: 'manual' };

  // Everything else gets the autofill assistant.
  return { strategy: 'browser' };
}

/**
 * Does this strategy actually SUBMIT the application, or only help fill it in?
 *
 * The distinction is the whole point of this module. `browser` fills fields and stops — the user
 * clicks Submit — so calling it "auto-apply" in the UI was a lie. Callers use this to pick honest
 * wording and to decide whether to record an application automatically.
 */
export function submitsDirectly(s: SubmissionStrategy): boolean {
  return s === 'greenhouse' || s === 'ashby';
}

/** What the user should see offered for this posting. */
export function strategyActionLabel(s: SubmissionStrategy): string {
  switch (s) {
    case 'greenhouse':
    case 'ashby':
      return 'Auto-apply';
    case 'linkedin':
      return 'Open LinkedIn & autofill';
    case 'naukri':
      return 'Open Naukri & autofill';
    case 'browser':
      return 'Open & autofill';
    case 'manual':
      return 'Apply on company site';
  }
}

/** Human-readable portal name for badges + the audit log. */
export function strategyLabel(s: SubmissionStrategy): string {
  switch (s) {
    case 'greenhouse': return 'Greenhouse';
    case 'ashby': return 'Ashby';
    case 'linkedin': return 'LinkedIn';
    case 'naukri': return 'Naukri';
    case 'browser': return 'Autofill assist';
    case 'manual': return 'Manual';
  }
}
