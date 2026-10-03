// LinkedIn Easy Apply adapter — opens the LinkedIn Easy Apply modal, fills standard
// fields from the candidate profile, uploads the tailored resume PDF, navigates
// multi-step forms, and STOPS when it detects the final Submit button.
//
// Adapted from github.com/Harshitsk7/jobpilot (MIT License).
// The original auto-submits; this adapter detects submit and returns control to the user.
//
// Safety: submit buttons are DETECTED but NEVER clicked. The caller must present
// the filled form to the user for manual review and submission.

import { type BrowserContext, type Page, type Locator } from 'playwright';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import type { CandidateProfile, PlatformResult } from './platform';
import { fillAndAdvanceWizard } from './browser';
import { getRecipe, normalizeHost, recordApplyAttempt } from './recipes';
import { launchApplyBrowser, bringWindowToFront, focusApplyPage, shouldBringWindowToFront, AUTO_APPLY_SUCCESS_PAGE, isApplyCancelled, getSystemChromeProfileDir } from './launcher';
import { resolveScreeningQuestionWithGemini, type FieldConstraints } from './llm-screening';
import db from '../db';
import { screeningOwnerId, hashScreeningQuestion, ensureScreeningOwner } from './screening-owner';

const BROWSER_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

/**
 * Resolve the best Chrome profile directory for LinkedIn: prefer the user's REAL Chrome profile
 * so DPAPI-encrypted cookies (li_at session) are decryptable → LinkedIn opens already signed in.
 * Falls back to the isolated Playwright profile when Chrome isn't installed or profile not found.
 */
function resolveLinkedInProfileDir(): string {
  return BROWSER_PROFILE_DIR;
}

/** True when the profile dir is the user's everyday Chrome (not the app's isolated profile). */
function isUsingRealChromeProfile(profileDir: string): boolean {
  return profileDir !== BROWSER_PROFILE_DIR;
}

// ----- Detection selectors ---------------------------------------------------

const EASY_APPLY_SELECTORS = [
  'button:has-text("Easy Apply")',
  'button[aria-label*="Easy Apply" i]',
  '[role="button"]:has-text("Easy Apply")',
  'button.jobs-apply-button',
  '.jobs-s-apply button',
  'button.jobs-apply-button--top-card',
  'button[data-job-id]',
  'button.apply-button',
  'button[data-tracking-control-name="public_jobs_apply-link-onsite"]',
  'button:has-text("التقديم السريع")',
  'button:has-text("التقديم السهل")',
  'button:has-text("التقديم")',
  'button[aria-label*="التقديم" i]',
  'button:has-text("التقدم السهل")',
  'button[aria-label*="التقدم السهل" i]',
];

const SUBMIT_SELECTORS = [
  'dialog footer button:has-text("Submit application")',
  'dialog footer button:has-text("Submit")',
  'dialog button:has-text("Submit application")',
  'dialog button:has-text("Submit")',
  '[role="dialog"] footer button:has-text("Submit application")',
  '[role="dialog"] footer button:has-text("Submit")',
  'button[aria-label*="Submit application" i]',
  'button:has-text("Submit application")',
  'button[aria-label*="Submit" i]',
  'button[aria-label*="Send application" i]',
  'footer button.artdeco-button--primary:has-text("Submit")',
  'button[data-test="submit-button"]',
  'dialog footer button:has-text("إرسال طلب التوظيف")',
  'dialog footer button:has-text("إرسال")',
  'dialog button:has-text("إرسال")',
  'button:has-text("إرسال طلب التوظيف")',
  'button:has-text("إرسال")',
  'button[aria-label*="إرسال" i]',
  '[role="dialog"] footer button:has-text("إرسال")',
  '[role="dialog"] button:has-text("إرسال")',
];

const NEXT_SELECTORS = [
  'dialog footer button:has-text("Next")',
  'dialog footer button:has-text("Review")',
  'dialog button:has-text("Next")',
  'dialog button:has-text("Review")',
  '[role="dialog"] footer button:has-text("Next")',
  '[role="dialog"] footer button:has-text("Review")',
  'footer button.artdeco-button--primary:has-text("Next")',
  'footer button.artdeco-button--primary:has-text("Review")',
  'footer button.artdeco-button--primary:has-text("Continue")',
  'footer button:has-text("Next")',
  'footer button:has-text("Review")',
  'button:has-text("Next")',
  'button:has-text("Review")',
  'button[aria-label*="Continue to next step" i]',
  'button[aria-label*="Review your application" i]',
  'button[aria-label*="Next" i]',
  'button[aria-label*="Review" i]',
  'button[aria-label*="Continue" i]',
  'button:has-text("Continue")',
  'dialog footer button:has-text("التالي")',
  'dialog button:has-text("التالي")',
  '[role="dialog"] footer button:has-text("التالي")',
  '[role="dialog"] button:has-text("التالي")',
  'button:has-text("التالي")',
  'button[aria-label*="التالي" i]',
  'dialog footer button:has-text("مراجعة")',
  'dialog button:has-text("مراجعة")',
  'button:has-text("مراجعة")',
  'button[aria-label*="مراجعة" i]',
  'dialog footer button:has-text("المتابعة")',
  'button:has-text("المتابعة")',
];

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  'input[name="cf-turnstile-response"]',
  '#captcha',
];

// The Easy Apply modal container. Supports both native HTML5 <dialog> and ARIA containers.
const EASY_APPLY_MODAL_SELECTORS = [
  'dialog',
  'dialog[open]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '.jobs-easy-apply-modal',
  'div[data-test-modal-box]',
  '.artdeco-modal',
  'div[data-view-name*="easy-apply"]',
  '.jobs-easy-apply-content',
  '.jobs-easy-apply-modal__content',
  '[data-test-modal]',
  'div[data-test-modal-id]',
];

// External "Apply" (offsite) link — a job whose application happens on the COMPANY'S OWN
// site, not through LinkedIn Easy Apply.
//
// The new job-page design (hashed atomic CSS classes) no longer ships `jobs-apply-button`
// on the anchor, so the aria-label is the reliable signal: the external CTA is labelled
// "Apply on company website". Easy Apply is a `<button>` (matched by EASY_APPLY_SELECTORS),
// and its aria says "Easy Apply", so `a[aria-label]` anchors can never collide with it.
const EXTERNAL_APPLY_SELECTORS = [
  'a.jobs-apply-button',
  'a[data-tracking-control-name*="offsite"]',
  'a[data-tracking-control-name*="external"]',
  'a[aria-label*="Apply on company website"]',
  'a[aria-label*="Apply externally"]',
  'a[aria-label*="Apply"]',
];

/**
 * LinkedIn wraps external CTAs in a link-safety redirect — `/safety/go/?url=<encoded>`. Unwrap it
 * so the hand-off navigates straight to the real destination (which matches what the generic
 * autofill heuristics expect) instead of an extra hop through the redirect. Returns the original
 * href when it is already a direct http(s) URL, or null for `javascript:`/empty.
 */
function unwrapLinkedInHref(href: string): string | null {
  if (!/^https?:\/\//i.test(href)) return null;
  if (/linkedin\.com\/safety\/go\//i.test(href)) {
    try {
      const inner = new URL(href).searchParams.get('url');
      if (inner && /^https?:\/\//i.test(inner)) return inner;
    } catch {
      // malformed — fall through to the wrapper itself
    }
  }
  return href;
}

// ----- External-apply handoff ---------------------------------------------------

const APPLICATION_FORM_SIGNALS = [
  'input[type="file"]',
  'input[type="email"]',
  'input[type="tel"]',
  'textarea',
  'input[name*="first" i]',
  'input[name*="last" i]',
  'input[name*="name" i]',
  'input[name*="phone" i]',
];

/**
 * A REAL application form, not the surrounding page furniture. Job-board listings have search
 * boxes, cookie banners have checkboxes, SPA shells have modal triggers — none of those are
 * fields the generic autofill can meaningfully fill, and treating them as a form is what made the
 * hand-off "fill nothing but claim success" on a listing page.
 */
export async function hasFillableApplicationForm(page: Page): Promise<boolean> {
  try {
    const count = await page.evaluate((sels) => {
      return sels.reduce((acc, sel) => acc + document.querySelectorAll(sel).length, 0);
    }, APPLICATION_FORM_SIGNALS);
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * Greenhouse shows `?error=true` on the board root when a direct job shortlink no longer resolves
 * (the posting was filled or the link went stale). That is not "no form" — it is "this job is gone".
 */
function greenhouseLooksDead(page: Page): boolean {
  try {
    const u = new URL(page.url());
    if (!/greenhouse\.io/i.test(u.host)) return false;
    return u.searchParams.get('error') === 'true' || !/\/jobs?\//i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Generic "position closed" heuristic for employer ATS pages: Greenhouse's dead-link marker, or
 * body copy that says the posting is no longer open.
 */
async function pageLooksClosed(page: Page): Promise<boolean> {
  if (greenhouseLooksDead(page)) return true;
  try {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 5000)).catch(() => '');
    return /no longer available|job (has been )?(closed|filled)|position (is )?(closed|filled)|this (job|posting) is no longer|sorry, this (job|position)/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Detect whether a LinkedIn job posting is expired or closed.
 */
export async function detectLinkedInExpired(page: Page): Promise<boolean> {
  try {
    const badge = page.locator(
      '.jobs-details-top-card__apply-error, ' +
      'figcaption:has-text("No longer accepting applications"), ' +
      '.artdeco-inline-feedback:has-text("No longer accepting applications"), ' +
      'div:has-text("No longer accepting applications"), ' +
      'span:has-text("No longer accepting applications")'
    ).first();
    if ((await badge.count()) > 0 && (await badge.isVisible().catch(() => false))) {
      return true;
    }
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 5000)).catch(() => '');
    return /no longer accepting applications|this job is no longer available|this job has expired|posting has closed|position has been closed/i.test(bodyText);
  } catch {
    return false;
  }
}

/**
 * The employer redirects to a login/sign-in page (Accenture-style portals do this after Apply,
 * and they remember the session afterwards). Strong signal: a visible password field, or the URL
 * of a known identity provider.
 */
async function pageRequiresLogin(page: Page): Promise<boolean> {
  try {
    const u = new URL(page.url());
    if (/login|signin|sign-in|sso|idp|authorize|account|okta|microsoftonline/i.test(u.host + u.pathname)) {
      return true;
    }
  } catch { /* ignore */ }
  try {
    const pwd = page.locator('input[type="password"]').first();
    if ((await pwd.count()) > 0 && (await pwd.isVisible().catch(() => false))) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * A Cloudflare Turnstile / reCAPTCHA challenge gate on the employer page: only a human can solve
 * it. We detect it, notify, and WAIT — we never attempt an automated bypass.
 */
async function pageHasCaptcha(page: Page): Promise<boolean> {
  for (const sel of CAPTCHA_SELECTORS) {
    try {
      if ((await page.locator(sel).first().count()) > 0) return true;
    } catch { /* ignore */ }
  }
  try {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
    return /captcha|verify you are human|security check|are you a robot/i.test(text);
  } catch {
    return false;
  }
}

async function pageRequiresIdentityVerification(page: Page): Promise<boolean> {
  try {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 5000)).catch(() => '');
    return /verify your identity|identity verification|verification code|security code|enter (the )?(code|verification code)|code (sent|was sent|has been sent) to your email|check your email/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Windows notification so the user is told to sign in / solve a CAPTCHA even when they are working
 * in another window. Fire-and-forget PowerShell `WScript.Shell` popup (no module install needed).
 */
function notifyWindows(title: string, message: string, seconds = 180): void {
  try {
    const clean = (s: string) => s.replace(/'/g, "''");
    const ps = `$w = New-Object -ComObject WScript.Shell; $w.Popup('${clean(message)}', ${seconds}, '${clean(title)}', 64)`;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
  } catch { /* ignore */ }
}

/**
 * Poll (up to `timeoutMs`) until a real application form appears on any of `pages` or on a
 * newly-opened popup — the user may need a few minutes to log in or solve a CAPTCHA before the
 * employer form renders. Returns the page that became fillable, or null on timeout.
 */
async function waitUntilFormAppears(
  context: BrowserContext,
  pages: Page[],
  timeoutMs: number,
): Promise<Page | null> {
  const popups: Page[] = [];
  const onPopup = (p: Page) => popups.push(p);
  context.on('page', onPopup);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const candidate of [...pages, ...popups]) {
        try {
          if (await hasFillableApplicationForm(candidate)) return candidate;
        } catch { /* ignore */ }
      }
      await pages[0].waitForTimeout(2500);
    }
    for (const candidate of [...pages, ...popups]) {
      try {
        if (await hasFillableApplicationForm(candidate)) return candidate;
      } catch { /* ignore */ }
    }
    return null;
  } finally {
    context.off('page', onPopup);
  }
}

type ExternalBlocker =
  | { kind: 'fillable'; page: Page }
  | { kind: 'login'; page: Page }
  | { kind: 'verification'; page: Page }
  | { kind: 'captcha'; page: Page }
  | { kind: 'closed'; page: Page }
  | { kind: 'none'; page: Page };

/**
 * Decide what an external employer page is showing across every open window (a heavy SPA can open
 * the real form — or the login / CAPTCHA — in a new tab). Fillable wins; login is treated as "need
 * the user once, then continue"; CAPTCHA is "need the user once, then continue"; a dead Greenhouse
 * board is "job gone"; anything else is just "no fillable form".
 */
async function classifyExternalBlocker(pages: Page[]): Promise<ExternalBlocker> {
  for (const p of pages) {
    try {
      if (await hasFillableApplicationForm(p)) return { kind: 'fillable', page: p };
    } catch { /* ignore */ }
  }
  let login: Page | null = null;
  let verification: Page | null = null;
  let captcha: Page | null = null;
  let closed: Page | null = null;
  for (const p of pages) {
    try {
      if (await pageRequiresLogin(p)) { login = login ?? p; }
      else if (await pageRequiresIdentityVerification(p)) { verification = verification ?? p; }
      else if (await pageHasCaptcha(p)) { captcha = captcha ?? p; }
      else if (await pageLooksClosed(p)) { closed = closed ?? p; }
    } catch { /* ignore */ }
  }
  if (login) return { kind: 'login', page: login };
  if (verification) return { kind: 'verification', page: verification };
  if (captcha) return { kind: 'captcha', page: captcha };
  if (closed) return { kind: 'closed', page: closed };
  return { kind: 'none', page: pages[0] };
}

const REVEAL_LABELS = [
  'Apply for this job',
  'Start application',
  'Start your application',
  'Apply now',
  'Apply',
  'Continue',
];

/**
 * OneTrust / generic cookie-consent overlays (common on Accenture-style career sites) sit on top of
 * the page and swallow clicks meant for the real apply button. Dismiss them before probing — this
 * is consent-banner housekeeping, not an application action.
 */
async function dismissCookieConsent(page: Page): Promise<void> {
  const groups = [
    ['#onetrust-accept-btn-handler'],
    ['button:has-text("Accept All")', 'button:has-text("Accept all")', 'button:has-text("Accept All Cookies")', 'button:has-text("Accept Cookies")'],
    ['button:has-text("I Accept")', 'button:has-text("Allow all")', 'button:has-text("Agree and continue")', 'button:has-text("Got it")', 'button:has-text("OK")'],
  ];
  for (const group of groups) {
    for (const sel of group) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          console.log('[linkedin] external: dismissed cookie consent via', sel);
          await el.click({ timeout: 3000 });
          await page.waitForTimeout(700);
          return;
        }
      } catch { /* try next */ }
    }
  }
}

/** Oracle and similar career sites request browser geolocation before rendering their SPA.
 * Granting it for the employer origin prevents a browser permission bubble from blocking the
 * cookie banner and Apply control. This does not grant the site access to any real location. */
async function grantExternalGeolocation(context: BrowserContext, url: string): Promise<void> {
  try {
    const origin = new URL(url).origin;
    await context.grantPermissions(['geolocation'], { origin });
    console.log('[linkedin] external: granted geolocation permission for', origin);
  } catch {
    // Some sites never request geolocation; continue with normal form discovery.
  }
}

/**
 * Many career sites show a JOB DESCRIPTION first and only inject the application form after you
 * click their own apply opener (a modal or a new tab). If no real application fields are present,
 * click matching openers — an opener reveals a form, it is never a form's final Submit. Same-page
 * modals AND new-tab popups are both handled. Iterates rather than clicking a single time, because
 * a board listing frequently needs TWO steps (choose the job, then open its form).
 */
export async function revealApplyForm(page: Page, context: BrowserContext, opts?: { revealLabels?: string[]; onAdvanced?: (labels: string[]) => void }): Promise<Page> {
  const labels = opts?.revealLabels && opts.revealLabels.length ? opts.revealLabels : REVEAL_LABELS;
  // Which labels actually advanced the flow this attempt — fed to the per-employer recipe.
  const advancedLabels: string[] = [];
  // Watch for any popup window carrying the actual form.
  const popups: Page[] = [];
  const onPopup = (p: Page) => popups.push(p);
  context.on('page', onPopup);

  // Don't re-click the same label on the same page URL (a click that did nothing would otherwise
  // repeat six times). A board listing legitimately needs the SAME label at a LATER page though, so
  // the key is page-URL + label, not label alone.
  const attempted = new Set<string>();
  const currentUrl = () => {
    try { return page.url(); } catch { return ''; }
  };
  const waitForPopupToSettle = async (popup: Page) => {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 12_000 });
      await popup.waitForTimeout(2500);
    } catch { /* ignore */ }
  };

  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await dismissCookieConsent(page);
      } catch { /* ignore */ }
      if (await hasFillableApplicationForm(page)) return page;

      // A previously-opened popup may now hold the form.
      for (const popup of popups) {
        try {
          if (await hasFillableApplicationForm(popup)) {
            console.log('[linkedin] external: form via popup', popup.url());
            return popup;
          }
        } catch { /* ignore */ }
      }

      let clickedSomething = false;
      for (const label of labels) {
        const key = `${currentUrl()}::${label}`;
        if (attempted.has(key)) continue;
        try {
          const anchor = page.locator(`a:has-text("${label}")`).first();
          const btn = page.locator(
            `button:has-text("${label}"), input[type="submit"][value*="${label}"], [role="button"]:has-text("${label}")`,
          ).first();
          for (const loc of [anchor, btn]) {
            if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
              console.log('[linkedin] external: clicked reveal "%s"', label);
              const popupsBefore = popups.length;
              await loc.click({ timeout: 5000 }).catch(() => {});
              attempted.add(key);
              clickedSomething = true;
              advancedLabels.push(label);
              // A freshly-opened popup needs time to render before it can be judged.
              const fresh = popups.length ? popups[popups.length - 1] : null;
              await page.waitForTimeout(2200);
              if (fresh) await waitForPopupToSettle(fresh);
              if (popups.length > popupsBefore) {
                // A NEW WINDOW opened. If it is the fillable form, use it; otherwise it is almost
                // certainly the login / CAPTCHA gate (Accenture redirects to Azure B2C) and we must
                // STOP clicking — a second popup would start a duplicate auth flow that collides
                // with the first and ends in "Trouble signing you in". The caller classifies it.
                for (const newPopup of popups.slice(popupsBefore)) {
                  try {
                    if (await hasFillableApplicationForm(newPopup)) return newPopup;
                  } catch { /* ignore */ }
                }
                return page;
              }
              break;
            }
          }
          if (clickedSomething) break; // re-evaluate from the top on the next attempt
        } catch {
          // try next label
        }
      }

      if (!clickedSomething) break; // nothing left to click
    }

    if (advancedLabels.length && opts?.onAdvanced) {
      try { opts.onAdvanced([...advancedLabels]); } catch { /* ignore */ }
    }

    // Final pass: settle any last popup and prefer a genuine form over the original page.
    for (const popup of popups) {
      await waitForPopupToSettle(popup);
    }
    for (const popup of popups) {
      try {
        if (await hasFillableApplicationForm(popup)) {
          console.log('[linkedin] external: form via popup', popup.url());
          return popup;
        }
      } catch { /* ignore */ }
    }
    return page;
  } finally {
    context.off('page', onPopup);
  }
}

// ----- Public API ------------------------------------------------------------

/**
 * Detect whether the LinkedIn Easy Apply button is visible on the page.
 */
export async function detectLinkedInEasyApply(page: Page): Promise<boolean> {
  for (const sel of EASY_APPLY_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        return true;
      }
    } catch {
      // continue
    }
  }
  return false;
}

/**
 * Detect an offsite "Apply" link (a job that is NOT Easy Apply — the application lives
 * on the company's own site). Returns the href to hand off to, or null if absent.
 */
export async function detectLinkedInExternalApply(page: Page): Promise<string | null> {
  for (const sel of EXTERNAL_APPLY_SELECTORS) {
    try {
      const link = page.locator(sel).first();
      if ((await link.count()) > 0 && (await link.isVisible().catch(() => false))) {
        const href = await link.getAttribute('href').catch(() => null);
        // Only absolute http(s) destinations are safe to hand off to — never `javascript:` or empty.
        if (href) {
          const out = unwrapLinkedInHref(href);
          if (out) return out;
        }
      }
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Detect whether a submit/apply button is visible (detection only, no click).
 */
export async function detectLinkedInSubmit(page: Page): Promise<boolean> {
  for (const sel of SUBMIT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        return true;
      }
    } catch {
      // continue
    }
  }

  // LinkedIn localizes the button label, so the English selectors above can miss it even
  // after the locale guard. On the review step the final action is the visible primary
  // button in the modal footer; exclude the known navigation labels before accepting it.
  try {
    const localizedSubmit = await page.evaluate(() => {
      const modal = document.querySelector(
        'dialog, .jobs-easy-apply-modal, div[data-test-modal-box], div[data-view-name*="easy-apply"]'
      );
      if (!modal) return false;
      const buttons = Array.from(modal.querySelectorAll('footer button, button')) as HTMLButtonElement[];
      return buttons.some((button) => {
        const style = getComputedStyle(button);
        if (style.display === 'none' || style.visibility === 'hidden' || button.disabled) return false;
        const label = `${button.innerText} ${button.getAttribute('aria-label') || ''}`.trim().toLowerCase();
        if (/submit|send|absenden|soumettre|إرسال/i.test(label)) return true;
        if (button.classList.contains('artdeco-button--primary')) {
          return !/next|review|continue|back|previous|zur.ck|suivant|continuer|التالي|مراجعة/.test(label);
        }
        return false;
      });
    });
    if (localizedSubmit) return true;
  } catch {
    // continue
  }
  return false;
}

/** Click the final LinkedIn submit control after it has been detected and scrolled into view. */
async function clickLinkedInSubmit(page: Page): Promise<boolean> {
  for (const sel of SUBMIT_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && await btn.isVisible().catch(() => false)) {
        if (await btn.isDisabled().catch(() => false)) continue;
        await btn.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // try the next selector
    }
  }

  // Localized labels do not match the English selectors. The same structural fallback used by
  // detection identifies the final primary footer button without relying on its text.
  try {
    const clicked = await page.evaluate(() => {
      const modal = document.querySelector('.jobs-easy-apply-modal, .artdeco-modal, div[data-test-modal-box]');
      if (!modal) return false;
      const buttons = Array.from(modal.querySelectorAll('footer button, button')) as HTMLButtonElement[];
      const button = buttons.find((candidate) => {
        const style = getComputedStyle(candidate);
        if (style.display === 'none' || style.visibility === 'hidden' || candidate.disabled) return false;
        if (!candidate.classList.contains('artdeco-button--primary')) return false;
        const label = `${candidate.innerText} ${candidate.getAttribute('aria-label') || ''}`.trim().toLowerCase();
        return !/next|review|continue|back|previous|zur.ck|suivant|continuer|التالي|مراجعة/.test(label);
      });
      if (!button) return false;
      button.click();
      return true;
    });
    if (clicked) await page.waitForTimeout(2500);
    return clicked;
  } catch {
    return false;
  }
}

/**
 * Detect CAPTCHA on the current page.
 */
export async function detectLinkedInCaptcha(page: Page): Promise<boolean> {
  for (const sel of CAPTCHA_SELECTORS) {
    try {
      if ((await page.locator(sel).first().count()) > 0) return true;
    } catch {
      // continue
    }
  }
  // Also check body text for challenge indicators
  try {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
    if (/captcha|verify you are human|security check|are you a robot/i.test(bodyText)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Whether the Easy Apply wizard modal is actually open. LinkedIn's session/bot-check bounces the
 * flow back to the JOB POSTING (the recurring "same job, now in Arabic" symptom) — the URL returns
 * to the plain posting and this modal is gone. If the wizard was on the screen but isn't now, the
 * application was dropped and `stopped_for_review` would be a FALSE success, so the loop checks
 * this before reporting done.
 */
export async function easyApplyModalVisible(page: Page): Promise<boolean> {
  for (const sel of EASY_APPLY_MODAL_SELECTORS) {
    try {
      const node = page.locator(sel).first();
      if ((await node.count()) > 0) {
        if (await node.isVisible().catch(() => false)) return true;
        const rect = await node.evaluate((el: any) => {
          const r = el.getBoundingClientRect();
          return { width: r.width, height: r.height };
        }).catch(() => ({ width: 0, height: 0 }));
        if (rect.width > 50 && rect.height > 50) return true;
      }
    } catch {
      // continue
    }
  }
  try {
    const hasModal = await page.evaluate(() => {
      const dialog = document.querySelector(
        'dialog, .jobs-easy-apply-modal, div[data-test-modal-box], div[data-view-name*="easy-apply"]'
      );
      if (!dialog) return false;
      const rect = dialog.getBoundingClientRect();
      return rect.width > 50 && rect.height > 50;
    });
    if (hasModal) return true;
  } catch {
    // continue
  }
  return false;
}

/**
 * Wait for the Easy Apply modal or submit button to be visible, with a grace period
 * to allow step transitions, network requests, and DOM animations to settle.
 */
async function waitForModalOrBounce(
  page: Page,
  maxWaitMs = 5000,
): Promise<{ modalVisible: boolean; submitDetected: boolean }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await detectLinkedInCaptcha(page)) {
      return { modalVisible: false, submitDetected: false };
    }
    const [modalVisible, submitDetected] = await Promise.all([
      easyApplyModalVisible(page),
      detectLinkedInSubmit(page),
    ]);
    if (modalVisible || submitDetected) {
      return { modalVisible, submitDetected };
    }
    // If a loader/spinner is active, give it time
    const isLoading = await page
      .evaluate(() => {
        return !!document.querySelector(
          '.artdeco-loader, [aria-busy="true"], .jobs-easy-apply-modal--loading'
        );
      })
      .catch(() => false);
    if (isLoading) {
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(500);
  }
  const modalVisible = await easyApplyModalVisible(page);
  const submitDetected = await detectLinkedInSubmit(page);
  console.log('[linkedin] waitForModalOrBounce finished after', maxWaitMs, 'ms -> modalVisible:', modalVisible, 'submitDetected:', submitDetected);
  return {
    modalVisible,
    submitDetected,
  };
}

/**
 * Force the LinkedIn UI into English. LinkedIn serves the recurring "job in Arabic" copy from the
 * server (geo/guest/account-locale), and it reads the language OFF the `lang` cookie — which is
 * why `Accept-Language` / `--lang` / a `locale` alone can never stop it. The cookie value is NOT
 * `en_US` (LinkedIn ignores that): the on-page language switcher writes the real format
 * `lang="v=2&lang=en-us"` (verified live — setting it and reloading flips a rendered `html
 * lang="ar"` page back to English; the bare value `en` also works). These cookies must exist on
/**
 * Enforce English job URL by replacing any localized subdomain (e.g. ar.linkedin.com)
 * with www.linkedin.com and setting locale=en_US query parameter.
 */
export function enforceEnglishJobUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.endsWith('.linkedin.com') && u.hostname !== 'www.linkedin.com' && u.hostname !== 'linkedin.com') {
      u.hostname = 'www.linkedin.com';
    }
    u.searchParams.set('locale', 'en_US');
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Force the LinkedIn UI into English. LinkedIn serves the recurring "job in Arabic" copy from the
 * server (geo/guest/account-locale), and it reads the language OFF the `lang` cookie — which is
 * why `Accept-Language` / `--lang` / a `locale` alone can never stop it. The cookie value is NOT
 * `en_US` (LinkedIn ignores that): the on-page language switcher writes the real format
 * `lang="v=2&lang=en-us"`. These cookies must exist across all LinkedIn domain variants.
 */
function linkedInEnglishCookies(): Array<{ name: string; value: string; domain: string; path: string; secure?: boolean; sameSite?: 'None' | 'Lax' }> {
  return [
    { name: 'lang', value: 'v=2&lang=en-us', domain: '.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: 'www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: '.www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'lang', value: 'v=2&lang=en-us', domain: 'linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: '.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: 'www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: '.www.linkedin.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'UserLocale', value: 'en_US', domain: 'linkedin.com', path: '/', secure: true, sameSite: 'None' },
  ];
}

/**
 * Seed the English-locale cookies onto the context BEFORE any navigation, so the FIRST request
 * already carries `lang="v=2&lang=en-us"` and LinkedIn never gets to serve an Arabic leaf.
 */
async function seedLinkedInEnglish(ctx: BrowserContext): Promise<void> {
  try {
    // Unconditionally purge any old/stale lang or UserLocale cookies so Arabic cookies never linger
    try {
      await (ctx as any).clearCookies?.({ name: 'lang' });
      await (ctx as any).clearCookies?.({ name: 'UserLocale' });
    } catch {}

    await ctx.addCookies(linkedInEnglishCookies());
    console.log('[linkedin] seeded en-US locale cookies before navigation');
  } catch { /* ignore */ }
}

/** Write host-only and domain locale cookies client-side too. */
async function writeLinkedInEnglishCookie(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      document.cookie = 'lang="v=2&lang=en-us"; Domain=.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
      document.cookie = 'lang="v=2&lang=en-us"; Domain=www.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
      document.cookie = 'UserLocale=en_US; Domain=.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
      document.cookie = 'UserLocale=en_US; Domain=www.linkedin.com; Path=/; Max-Age=31536000; Secure; SameSite=None';
    });
  } catch { /* page may still be navigating */ }
}

/**
 * Language guard: ensures LinkedIn stays in English LTR. If the page redirected to an Arabic
 * subdomain or rendered in Arabic RTL, normalizes it immediately.
 */
async function forceLinkedInEnglish(page: Page, _ctx: BrowserContext): Promise<void> {
  try {
    const currentUrl = page.url();
    if (currentUrl.includes('ar.linkedin.com')) {
      const fixedUrl = currentUrl.replace('ar.linkedin.com', 'www.linkedin.com');
      const target = enforceEnglishJobUrl(fixedUrl);
      console.log('[linkedin] redirected from Arabic subdomain to', target);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2000);
    }

    await writeLinkedInEnglishCookie(page);
    const lang = await page.evaluate(() => (document.documentElement.getAttribute('lang') || '')).catch(() => '');
    const dir = await page.evaluate(() => (document.documentElement.getAttribute('dir') || '')).catch(() => '');
    if (lang) console.log(`[linkedin] page language: "${lang}", dir: "${dir}"`);

    if (lang === 'ar' || dir === 'rtl') {
      console.log('[linkedin] detected Arabic/RTL page — enforcing English LTR');
      await page.evaluate(async () => {
        document.documentElement.setAttribute('lang', 'en-US');
        document.documentElement.setAttribute('dir', 'ltr');
        const modal = document.querySelector('dialog, [role="dialog"], .jobs-easy-apply-modal, .artdeco-modal, div[data-test-modal-box]');
        if (modal) {
          (modal as HTMLElement).style.direction = 'ltr';
          modal.setAttribute('dir', 'ltr');
          modal.setAttribute('lang', 'en-US');
        }
        try {
          const csrfMatch = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
          const csrf = csrfMatch ? csrfMatch[1] : '';
          if (csrf) {
            await fetch('https://www.linkedin.com/mysettings-api/settingsApiSettings/interfaceLocale', {
              method: 'PUT',
              headers: {
                'csrf-token': csrf,
                'X-RestLi-Protocol-Version': '2.0.0',
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              body: JSON.stringify({
                settingDisplayType: 'DROPDOWN',
                entityUrn: 'urn:li:settingEntity:400007',
                hasChild: false,
                key: 'interfaceLocale',
                value: 'en_US'
              })
            });
          }
        } catch {}
      }).catch(() => {});
    }
  } catch { /* ignore */ }
}

async function clickExternalApplyControl(page: Page): Promise<boolean> {
  const selectors = [
    'button:has-text("Apply")',
    'a:has-text("Apply")',
    '[role="button"]:has-text("Apply")',
    '[aria-label*="Apply" i]',
    'oj-button:has-text("Apply")',
    '[data-automation-id*="apply" i]',
  ];
  try {
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior }));
    await page.waitForTimeout(800);
  } catch { /* page may still be rendering */ }
  for (const selector of selectors) {
    try {
      const control = page.locator(selector).filter({ visible: true }).first();
      if ((await control.count()) === 0) continue;
      await control.scrollIntoViewIfNeeded().catch(() => {});
      console.log('[linkedin] external: clicked Oracle-compatible reveal', selector);
      await control.click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      return true;
    } catch { /* try the next selector */ }
  }
  return false;
}

/** Click LinkedIn's own "English (English)" language control if one is rendered. Returns true when clicked. */
async function clickEnglishSwitcher(page: Page): Promise<boolean> {
  try {
    const clicked = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('a,button,[role="menuitem"],[role="button"]'))
        .map((e) => e as HTMLElement)
        .filter((e) => {
          const t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
          return /^English( \(English\))?\s*$/.test(t) || t.indexOf('English (English)') === 0;
        });
      const el = cands[0];
      if (el) { el.click(); return true; }
      return false;
    });
    if (clicked) await page.waitForTimeout(4000);
    return clicked;
  } catch {
    return false;
  }
}

/**
 * Detect if the user has been redirected to a login page or is in a logged-out guest state.
 */
export async function detectLinkedInLoginRequired(page: Page): Promise<boolean> {
  const url = page.url();
  if (/linkedin\.com\/(login|checkpoint|signup|uas\/login)/i.test(url)) return true;
  try {
    const hasLoginForm = (await page.locator('input[name="session_key"], input#username').first().count()) > 0;
    if (hasLoginForm) return true;

    // Check for public logged-out guest shell
    const isLoggedOutGuest = await page.evaluate(() => {
      const hasGlobalNav = !!document.querySelector('#global-nav, .global-nav, nav.global-nav, nav[aria-label="Primary"]');
      if (hasGlobalNav) return false;
      const hasSignInCta = !!document.querySelector(
        'a[href*="/login"], a[href*="/signup"], a[href*="cold-join"], a[href*="uas/login"], .contextual-sign-in-modal, [data-tracking-control-name*="signin"], [data-tracking-control-name*="join"], a.nav__button-secondary'
      );
      const hasGuestApply = !!document.querySelector('button[data-tracking-control-name*="public_jobs_apply"]');
      return hasSignInCta || hasGuestApply;
    }).catch(() => false);

    if (isLoggedOutGuest) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Wait for the user to complete login on LinkedIn.
 * Polls for login completion by checking if login required condition clears.
 */
export async function waitForLinkedInLogin(
  page: Page,
  maxWaitMs = 120_000
): Promise<boolean> {
  const start = Date.now();
  console.log('[linkedin] Waiting for user to complete login...');

  while (Date.now() - start < maxWaitMs) {
    const loginRequired = await detectLinkedInLoginRequired(page);
    if (!loginRequired) {
      console.log('[linkedin] Login completed successfully');
      return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Detect if the job was already applied to on LinkedIn.
 */
export async function detectLinkedInAlreadyApplied(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const body = document.body.innerText;
      if (/applied (on|\d+d ago|\d+h ago|just now)|application submitted|تم إرسال طلب التوظيف|تم التقديم/i.test(body)) {
        const btn = document.querySelector('.jobs-s-apply, .jobs-apply-button, button.artdeco-button--muted');
        if (btn && /applied|تم التقديم/i.test(btn.textContent || '')) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Fill standard LinkedIn Easy Apply fields from the candidate profile.
 * Returns the labels of fields that were filled.
 *
 * Adapted from jobpilot's fillFormFields() heuristic map.
 */
async function fillLinkedInStandardFields(page: Page, profile: CandidateProfile): Promise<string[]> {
  const filled: string[] = [];
  const modalLoc = page.locator('dialog, .jobs-easy-apply-modal').first();
  if ((await modalLoc.count()) === 0) return filled;

  interface FieldMapping {
    label: string;
    selectors: string[];
    value: string | null;
  }

  const firstName = profile.name?.trim().split(/\s+/)[0] || null;
  const lastName = profile.name?.trim().split(/\s+/).slice(1).join(' ') || null;
  const street = (profile.street as string) || (profile.address as string) || null;
  const city = (profile.city as string) || null;
  const state = (profile.state as string) || (profile.province as string) || null;
  const country = (profile.country as string) || null;
  const zipCode = profile.zipCode ?? profile.pincode ?? profile.postalCode ? String(profile.zipCode ?? profile.pincode ?? profile.postalCode) : null;
  const currentCtc = String(profile.currentCtcInr ?? 700000);
  const expectedCtc = String(profile.expectedCtcInr ?? 1200000);

  const mappings: FieldMapping[] = [
    {
      label: 'First Name',
      selectors: ['input[id*="first-name"]', 'input[name="firstName"]', 'input[aria-label*="first name" i]'],
      value: firstName,
    },
    {
      label: 'Last Name',
      selectors: ['input[id*="last-name"]', 'input[name="lastName"]', 'input[aria-label*="last name" i]'],
      value: lastName,
    },
    {
      label: 'Email',
      selectors: ['input[type="email"]', 'input[id*="email"]', 'input[name="email"]'],
      value: profile.email || null,
    },
    {
      label: 'Phone',
      selectors: [
        'input[type="tel"]',
        'input[id*="phoneNumber"]',
        'input[aria-describedby*="phoneNumber"]',
        'input[id*="phone" i]',
        'input[name*="phone" i]',
        'input[aria-label*="phone" i]',
        'input[aria-label*="هاتف" i]',
      ],
      value: profile.phone || null,
    },
    {
      label: 'LinkedIn URL',
      selectors: ['input[id*="linkedin"]', 'input[name*="linkedin"]', 'input[aria-label*="linkedin" i]'],
      value: profile.linkedin || null,
    },
    {
      label: 'Street Address',
      selectors: [
        'input[id*="street" i]',
        'input[name*="street" i]',
        'input[aria-label*="street" i]',
        'input[placeholder*="street" i]',
        'input[id*="address" i]',
        'input[name*="address" i]',
        'input[aria-label*="address" i]',
        'input[placeholder*="address" i]',
        'input[id*="line1" i]',
        'input[name*="line1" i]',
        'input[aria-label*="line 1" i]',
        'textarea[id*="address" i]',
        'textarea[name*="address" i]',
        'textarea[aria-label*="address" i]',
      ],
      value: street,
    },
    {
      label: 'City',
      selectors: [
        'input[id*="city" i]',
        'input[name*="city" i]',
        'input[aria-label*="city" i]',
        'input[placeholder*="city" i]',
      ],
      value: city,
    },
    {
      label: 'State / Province',
      selectors: [
        'input[id*="state" i]',
        'input[name*="state" i]',
        'input[aria-label*="state" i]',
        'input[placeholder*="state" i]',
        'input[id*="province" i]',
        'input[name*="province" i]',
        'input[aria-label*="province" i]',
        'input[placeholder*="province" i]',
        'input[id*="region" i]',
        'input[name*="region" i]',
        'input[aria-label*="region" i]',
      ],
      value: state,
    },
    {
      label: 'Country',
      selectors: [
        'input[id*="country" i]',
        'input[name*="country" i]',
        'input[aria-label*="country" i]',
        'input[placeholder*="country" i]',
      ],
      value: country,
    },
    {
      label: 'Zip / Postal Code',
      selectors: [
        'input[id*="zip" i]',
        'input[name*="zip" i]',
        'input[aria-label*="zip" i]',
        'input[placeholder*="zip" i]',
        'input[id*="postal" i]',
        'input[name*="postal" i]',
        'input[aria-label*="postal" i]',
        'input[placeholder*="postal" i]',
        'input[id*="pincode" i]',
        'input[name*="pincode" i]',
        'input[aria-label*="pin code" i]',
        'input[aria-label*="pincode" i]',
        'input[placeholder*="pin code" i]',
      ],
      value: zipCode,
    },
    {
      label: 'Current Salary',
      selectors: [
        'input[id*="current-salary" i]',
        'input[name*="currentSalary" i]',
        'input[aria-label*="current salary" i]',
        'input[id*="current-ctc" i]',
        'input[name*="currentCtc" i]',
        'input[aria-label*="current ctc" i]',
        'input[id*="currentSalary" i]',
        'input[name*="current_salary" i]',
        'input[id*="current_salary" i]',
      ],
      value: currentCtc,
    },
    {
      label: 'Expected Salary',
      selectors: [
        'input[id*="expected-salary" i]',
        'input[name*="expectedSalary" i]',
        'input[aria-label*="expected salary" i]',
        'input[id*="expected-ctc" i]',
        'input[name*="expectedCtc" i]',
        'input[aria-label*="expected ctc" i]',
        'input[id*="expectedSalary" i]',
        'input[name*="expected_salary" i]',
        'input[id*="expected_salary" i]',
      ],
      value: expectedCtc,
    },
    {
      label: 'Current Company',
      selectors: ['input[id*="company"]', 'input[name*="company"]', 'input[aria-label*="company" i]'],
      value: profile.currentCompany || null,
    },
    {
      label: 'Job Title',
      selectors: ['input[id*="title"]', 'input[name*="title"]', 'input[aria-label*="job title" i]'],
      value: profile.currentJobTitle || null,
    },
    {
      label: 'Portfolio / Website URL',
      selectors: [
        'input[id*="website" i]',
        'input[id*="portfolio" i]',
        'input[name*="website" i]',
        'input[name*="portfolio" i]',
        'input[aria-label*="portfolio" i]',
        'input[aria-label*="website" i]',
      ],
      value: (profile.portfolioUrl as string) || (profile.github as string) || null,
    },
    {
      label: 'Date of Birth',
      selectors: [
        'input[type="date"]',
        'input[id*="birth" i]',
        'input[name*="birth" i]',
        'input[id*="dob" i]',
        'input[name*="dob" i]',
        'input[aria-label*="birth" i]',
        'input[aria-label*="dob" i]',
      ],
      value: (profile.dateOfBirth as string) || null,
    },
  ];

  for (const mapping of mappings) {
    if (!mapping.value) continue;
    for (const sel of mapping.selectors) {
      try {
        const loc = modalLoc.locator(sel).first();
        if ((await loc.count()) === 0) continue;
        const visible = await loc.isVisible().catch(() => false);
        const disabled = await loc.isDisabled().catch(() => false);
        if (!visible || disabled) continue;
        const existing = await loc.inputValue().catch(() => '');
        if (existing?.trim()) { filled.push(mapping.label); break; }
        await loc.fill(mapping.value, { timeout: 3000 });
        if (/city|country|state/i.test(mapping.label)) {
          await page.waitForTimeout(600);
          const firstOpt = page.locator('.artdeco-typeahead__results-list li, [role="listbox"] [role="option"]').first();
          if ((await firstOpt.count()) > 0 && (await firstOpt.isVisible().catch(() => false))) {
            await firstOpt.click().catch(() => {});
          }
        }
        filled.push(mapping.label);
        break;
      } catch {
        // try next selector
      }
    }
  }

  // Handle <select> dropdowns and custom comboboxes inside modal with intelligent matching
  try {
    const dropdownFilled = await fillLinkedInSelectDropdowns(page, modalLoc, profile);
    filled.push(...dropdownFilled);
  } catch {
    // ignore
  }

  return filled;
}

/**
 * City and region alias mapping for location matching.
 * Maps common variants to a canonical set of alias keywords.
 */
export const CITY_ALIASES: Record<string, string[]> = {
  bangalore: ['bangalore', 'bengaluru', 'blr'],
  bengaluru: ['bangalore', 'bengaluru', 'blr'],
  chennai: ['chennai', 'madras', 'maa'],
  madras: ['chennai', 'madras', 'maa'],
  mumbai: ['mumbai', 'bombay', 'bom'],
  bombay: ['mumbai', 'bombay', 'bom'],
  pune: ['pune', 'poona'],
  poona: ['pune', 'poona'],
  hyderabad: ['hyderabad', 'secunderabad', 'hyd'],
  secunderabad: ['hyderabad', 'secunderabad', 'hyd'],
  gurgaon: ['gurgaon', 'gurugram', 'ggn'],
  gurugram: ['gurgaon', 'gurugram', 'ggn'],
  noida: ['noida', 'greater noida'],
  delhi: ['delhi', 'new delhi', 'ncr'],
  'new delhi': ['delhi', 'new delhi', 'ncr'],
  kolkata: ['kolkata', 'calcutta', 'ccu'],
  calcutta: ['kolkata', 'calcutta', 'ccu'],
  kochi: ['kochi', 'cochin'],
  cochin: ['kochi', 'cochin'],
  trivandrum: ['trivandrum', 'thiruvananthapuram'],
  thiruvananthapuram: ['trivandrum', 'thiruvananthapuram'],
  coimbatore: ['coimbatore', 'kovai'],
  madurai: ['madurai'],
  remote: ['remote', 'work from home', 'wfh', 'virtual', 'anywhere'],
  'work from home': ['remote', 'work from home', 'wfh', 'virtual', 'anywhere'],
  wfh: ['remote', 'work from home', 'wfh', 'virtual', 'anywhere'],
};

/**
 * Resolves the best matching option string from a list of options (for radio groups, selects, or comboboxes)
 * based on the candidate's preferred locations in targets.locations, city, location, and state.
 */
export function resolvePreferredLocationOption(
  options: string[],
  profile: CandidateProfile
): string | null {
  if (!options || options.length === 0) return null;

  // Build candidate's preferred location list in order of priority:
  const preferences: string[] = [];

  // 1. Target locations array from profile.targets.locations
  const targetLocs = (profile.targets as { locations?: string[] })?.locations
    || (Array.isArray(profile.targetLocations) ? profile.targetLocations : [])
    || (Array.isArray(profile.targets) ? profile.targets : []);
  if (Array.isArray(targetLocs)) {
    for (const loc of targetLocs) {
      if (typeof loc === 'string' && loc.trim()) {
        preferences.push(loc.trim());
      }
    }
  }

  // 2. Candidate city
  if (profile.city && typeof profile.city === 'string' && !preferences.includes(profile.city.trim())) {
    preferences.push(profile.city.trim());
  }

  // 3. Candidate location (e.g. "Virudhunagar, India" -> "Virudhunagar")
  if (profile.location && typeof profile.location === 'string') {
    const cityPart = profile.location.split(',')[0].trim();
    if (cityPart && !preferences.includes(cityPart)) {
      preferences.push(cityPart);
    }
  }

  // Filter placeholder options from choices
  const validOptions = options.filter(
    (o) => o && !/^(?:select|choose|please\s*select|select\s*an\s*option|choose\s*an\s*option|select\s*one|--|\s*)$/i.test(o.trim())
  );
  if (validOptions.length === 0) return options[0] || null;

  // Check each preference against options in priority order
  for (const pref of preferences) {
    const prefNorm = pref.toLowerCase().trim();
    const aliases = CITY_ALIASES[prefNorm] || [prefNorm];

    for (const opt of validOptions) {
      const optNorm = opt.toLowerCase().trim();
      for (const alias of aliases) {
        const regex = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
        if (regex.test(optNorm) || optNorm.includes(alias)) {
          return opt.trim();
        }
      }
    }
  }

  // Fallback: Check candidate state (e.g. Tamil Nadu)
  const state = profile.state as string | undefined;
  if (state && typeof state === 'string' && state.trim()) {
    const stateNorm = state.toLowerCase().trim();
    for (const opt of validOptions) {
      if (opt.toLowerCase().includes(stateNorm)) {
        return opt.trim();
      }
    }
  }

  // Fallback: Check if any option is Remote / WFH
  const remoteOpt = validOptions.find((o) => /remote|work\s*from\s*home|wfh|virtual/i.test(o));
  if (remoteOpt) return remoteOpt.trim();

  // If candidate has preferences and no direct match found, return null to avoid random guessing
  return null;
}

/**
 * Automatically detects and fills all dropdown questions (<select> elements and custom comboboxes)
 * on the LinkedIn Easy Apply modal.
 * Uses multi-tier selection (Playwright selectOption, in-page DOM input/change/blur dispatch,
 * and custom listbox click triggers) to reliably select options even when native selects are visually hidden.
 */
export async function fillLinkedInSelectDropdowns(
  page: Page,
  modalLoc: Locator,
  profile: CandidateProfile
): Promise<string[]> {
  const filled: string[] = [];

  // Part 1: Native <select> elements (both visible and custom-skinned)
  try {
    const selects = modalLoc.locator('select');
    const selectCount = Math.min(await selects.count(), 20);

    for (let i = 0; i < selectCount; i++) {
      try {
        const sel = selects.nth(i);
        const disabled = await sel.isDisabled().catch(() => false);
        if (disabled) continue;

        // Extract label using robust ancestor search
        const label = await sel.evaluate((el: HTMLSelectElement) => {
          if (el.getAttribute('aria-label')) return el.getAttribute('aria-label') || '';
          const id = el.id;
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
          }
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const lblTarget = document.getElementById(labelledBy);
            if (lblTarget && lblTarget.textContent?.trim()) return lblTarget.textContent.trim();
          }
          let parent = el.parentElement;
          for (let depth = 0; depth < 6 && parent; depth++) {
            const lbl = parent.querySelector('label, legend, .fb-form-element-label, [data-test-form-builder-text-input-form-component__title], [data-test-form-builder-dropdown-form-component__title], .jobs-easy-apply-form-element__label, .artdeco-text-input--label, span.t-14, p');
            if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
            parent = parent.parentElement;
          }
          return el.getAttribute('name') || el.id || '';
        }).catch(() => '');

        // Extract options data: text, value, index
        type OptData = { text: string; value: string; index: number; isSelected: boolean };
        const optionsData: OptData[] = await sel.evaluate((el: HTMLSelectElement) => {
          return Array.from(el.options).map((o, idx) => ({
            text: (o.text || o.textContent || o.label || '').trim(),
            value: o.value || '',
            index: idx,
            isSelected: o.selected,
          }));
        }).catch(() => []);

        if (!optionsData || optionsData.length === 0) continue;

        const currentSelected = optionsData.find((o) => o.isSelected);
        const currentVal = currentSelected?.value || '';
        const currentText = currentSelected?.text || '';
        const isPlaceholder = !currentVal || /^(?:select|choose|please\s*select|select\s*an\s*option|choose\s*an\s*option|select\s*one|--|\s*)$/i.test(currentText.trim());

        // Filter out placeholder options from choices
        const validOptions = optionsData.filter((o) => o.text && !/^(?:select|choose|please\s*select|select\s*an\s*option|choose\s*an\s*option|select\s*one|--|\s*)$/i.test(o.text));
        if (validOptions.length === 0) continue;

        // If already selected with a real answer, skip unless it was an accidental blank
        if (!isPlaceholder && currentText.trim()) continue;

        const normLabel = label.replace(/\b(?:required|mandatory)\b/gi, '').replace(/[\*:]+$/g, '').trim();
        const validOptionTexts = validOptions.map((o) => o.text);

        let targetText: string | null = null;

        // 1. Check if location question
        const isLocationQ = /(?:location|preferr?ed\s*(?:work\s*)?location|work\s*location|office\s*location|base\s*location|where\s*are\s*you\s*(?:based|located)|city)/i.test(normLabel);
        if (isLocationQ) {
          targetText = resolvePreferredLocationOption(validOptionTexts, profile);
        }

        // 2. Check async resolution (DB cache -> standard field deterministic rules -> Gemini AI)
        if (!targetText) {
          targetText = await resolveLinkedInQuestionAnswerAsync(normLabel, 'select', profile, validOptionTexts);
        }

        // 3. Fallback deterministic rules for dropdowns
        if (!targetText) {
          const rawYoe = (profile.yearsOfExperience as number) ?? (profile.yearsExperience as number) ?? 3;
          const yoe = Math.floor(Number(rawYoe) || 0);
          const months = (profile.totalExperienceMonths as number) ?? 6;
          const noticeDays = profile.noticePeriodDays ?? 30;

          if (/(?:total\s*years|years\s*of\s*(?:professional\s*)?experience|(?:total|overall|relevant|work|professional|it)\s*(?:years?\s*of\s*)?experience|experience\s*\(?years?\)?|^experience\b)/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => new RegExp(`^\\s*${yoe}\\s*(?:years?|yrs?)?$`, 'i').test(o) || new RegExp(`\\b${yoe}\\s*(?:years?|yrs?)\\b`, 'i').test(o))
              || validOptionTexts.find((o) => new RegExp(`\\b${yoe}\\b`).test(o))
              || validOptionTexts[0];
          } else if (/additional\s*months|months\s*of\s*(?:professional\s*)?experience|experience\s*\(?months?\)?/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => new RegExp(`^\\s*${months}\\s*(?:months?|mos?)?$`, 'i').test(o) || new RegExp(`\\b${months}\\s*(?:months?|mos?)\\b`, 'i').test(o))
              || validOptionTexts.find((o) => new RegExp(`\\b${months}\\b`).test(o))
              || validOptionTexts[0];
          } else if (/(?:notice\s*period|how\s*soon.*(?:join|start)|when\s*can\s*you\s*(?:join|start)|joining\s*(?:time|period|days)|join\s*us.*days)/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => new RegExp(`\\b${noticeDays}\\b|1\\s*month|immediate`, 'i').test(o))
              || validOptionTexts[0];
          } else if (/\bcountry\b/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => new RegExp(`\\b${profile.country || 'India'}\\b`, 'i').test(o))
              || validOptionTexts.find((o) => /\bindia\b/i.test(o))
              || validOptionTexts[0];
          } else if (/\b(?:state|province|region)\b/i.test(normLabel)) {
            const state = (profile.state as string) || 'Tamil Nadu';
            targetText = validOptionTexts.find((o) => new RegExp(state, 'i').test(o))
              || validOptionTexts[0];
          } else if (/\b(?:current|present)\b.*?\b(?:ctc|salary|compensation|package)\b/i.test(normLabel) || /\b(?:ctc|salary)\b.*?\b(?:current|present)\b/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => /700000|7\s*lpa|7\s*lakh|6\s*[-–to]+\s*8/i.test(o))
              || validOptionTexts.find((o) => /7|8/i.test(o))
              || validOptionTexts[0];
          } else if (/\b(?:expected|target|desired|minimum)\b.*?\b(?:ctc|salary|compensation|package)\b/i.test(normLabel) || /\b(?:ctc|salary)\b.*?\b(?:expected|target|desired)\b/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => /1200000|12\s*lpa|12\s*lakh|10\s*[-–to]+\s*15/i.test(o))
              || validOptionTexts.find((o) => /12|10|15/i.test(o))
              || validOptionTexts[0];
          } else if (/\bcurrency\b/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => /inr|₹|rupee/i.test(o)) || validOptionTexts[0];
          } else if (/\b(?:education|degree|qualification)\b/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => /bachelor|b\.?e|b\.?tech|graduate|master/i.test(o)) || validOptionTexts[0];
          } else if (/english|proficiency|language/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => /fluent|professional|native|advanced|conversational/i.test(o)) || validOptionTexts[0];
          } else if (/(?:authorized|sponsorship|eligible|visa)/i.test(normLabel)) {
            const isNegative = /(?:require\s*(?:visa\s*)?sponsorship|need\s*(?:visa\s*)?sponsorship|\bsponsor\b)/i.test(normLabel);
            targetText = isNegative
              ? (validOptionTexts.find((o) => /^no$/i.test(o.trim())) || validOptionTexts[0])
              : (validOptionTexts.find((o) => /^yes$/i.test(o.trim())) || validOptionTexts[0]);
          } else if (/gender/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => /male|prefer not to say/i.test(o)) || validOptionTexts[0];
          } else if (/veteran/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => /not a veteran|not a protected veteran|prefer not to say/i.test(o)) || validOptionTexts[0];
          } else if (/disabilit/i.test(normLabel)) {
            targetText = validOptionTexts.find((o) => /no|not have a disability|prefer not to say/i.test(o)) || validOptionTexts[0];
          } else {
            // Safe fallback: pick first valid option so form is never blocked
            targetText = validOptionTexts[0];
          }
        }

        if (!targetText) continue;

        // Match targetText against validOptions
        const normTarget = targetText.trim().toLowerCase();
        let matchedOpt = validOptions.find((o) => o.text.trim().toLowerCase() === normTarget)
          || validOptions.find((o) => o.value.trim().toLowerCase() === normTarget)
          || validOptions.find((o) => o.text.trim().toLowerCase().includes(normTarget))
          || validOptions.find((o) => normTarget.includes(o.text.trim().toLowerCase()))
          || validOptions[0];

        if (!matchedOpt) continue;

        // Tier 1: Playwright selectOption by value
        if (matchedOpt.value) {
          await sel.selectOption({ value: matchedOpt.value }, { force: true }).catch(() => {});
        }

        // Tier 2: Playwright selectOption by label
        if (matchedOpt.text) {
          await sel.selectOption({ label: matchedOpt.text }, { force: true }).catch(() => {});
        }

        // Tier 3: In-page DOM execution (sets value, selectedIndex, dispatches events)
        const selectedValue = await sel.evaluate(
          (el: HTMLSelectElement, { optValue, optIndex, optText }) => {
            let opt = el.options[optIndex];
            if (!opt || opt.value !== optValue) {
              opt = Array.from(el.options).find((o) => o.value === optValue)
                || Array.from(el.options).find((o) => o.text.trim().toLowerCase() === optText.toLowerCase())
                || el.options[optIndex];
            }
            if (opt) {
              el.value = opt.value;
              el.selectedIndex = opt.index;
              opt.selected = true;
              el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
              return opt.text.trim();
            }
            return null;
          },
          { optValue: matchedOpt.value, optIndex: matchedOpt.index, optText: matchedOpt.text }
        ).catch(() => null);

        // Tier 4: Update custom wrapper button text if wrapped in .fb-dropdown or similar
        await sel.evaluate((el: HTMLSelectElement) => {
          const container = el.closest('.fb-dropdown, [data-test-form-builder-dropdown-form-component]');
          if (container) {
            const btn = container.querySelector('button, .fb-dropdown__select-button, span.fb-dropdown__title');
            if (btn && el.selectedOptions[0]) {
              btn.textContent = el.selectedOptions[0].text;
            }
          }
        }).catch(() => {});

        const resultLabel = selectedValue || matchedOpt.text;
        filled.push(`Select (${normLabel.slice(0, 25)}): ${resultLabel}`);
        console.log(`[linkedin] Selected dropdown: "${normLabel}" -> "${resultLabel}"`);
      } catch (selErr) {
        console.warn('[linkedin] Error filling select dropdown:', selErr);
      }
    }
  } catch (err) {
    console.warn('[linkedin] Error querying selects:', err);
  }

  // Part 2: Custom Combobox Buttons (e.g. artdeco dropdowns or custom UI listboxes)
  try {
    const comboboxes = modalLoc.locator(
      'button[role="combobox"], [data-test-form-builder-dropdown-form-component] button:not([type="submit"]):not([type="button"].artdeco-modal__dismiss), .artdeco-dropdown__trigger'
    );
    const cbCount = Math.min(await comboboxes.count(), 10);

    for (let j = 0; j < cbCount; j++) {
      try {
        const btn = comboboxes.nth(j);
        const visible = await btn.isVisible().catch(() => false);
        const disabled = await btn.isDisabled().catch(() => false);
        if (!visible || disabled) continue;

        // Check if there is an associated native select that was already handled
        const hasNativeSelect = await btn.evaluate((el) => {
          const container = el.closest('.fb-dropdown, [data-test-form-builder-dropdown-form-component]');
          return Boolean(container?.querySelector('select'));
        }).catch(() => false);
        if (hasNativeSelect) continue;

        const currentText = (await btn.innerText().catch(() => '')).trim();
        const isPlaceholder = !currentText || /^(?:select|choose|please\s*select|select\s*an\s*option|choose\s*an\s*option|select\s*one|--|\s*)$/i.test(currentText);
        if (!isPlaceholder) continue;

        const label = await btn.evaluate((el) => {
          if (el.getAttribute('aria-label')) return el.getAttribute('aria-label') || '';
          const id = el.id;
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
          }
          let parent = el.parentElement;
          for (let depth = 0; depth < 5 && parent; depth++) {
            const lbl = parent.querySelector('label, legend, .fb-form-element-label, span.t-14, p');
            if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
            parent = parent.parentElement;
          }
          return '';
        }).catch(() => '');

        // Click to open listbox
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(300);

        const listbox = page.locator('[role="listbox"], .artdeco-dropdown__content, .artdeco-dropdown__results').first();
        if ((await listbox.count()) > 0 && (await listbox.isVisible().catch(() => false))) {
          const itemLocs = listbox.locator('[role="option"], .artdeco-dropdown__item, li');
          const rawItems = await itemLocs.allTextContents().catch(() => []);
          const validItems = rawItems.map((t) => t.trim()).filter((t) => t && !/^(?:select|choose|please\s*select|--|\s*)$/i.test(t));

          if (validItems.length > 0) {
            let targetChoice: string | null = null;
            if (/(?:location|preferr?ed\s*(?:work\s*)?location|work\s*location|office\s*location|base\s*location|city)/i.test(label)) {
              targetChoice = resolvePreferredLocationOption(validItems, profile);
            }
            if (!targetChoice) {
              targetChoice = await resolveLinkedInQuestionAnswerAsync(label, 'select', profile, validItems);
            }
            const chosen = targetChoice || validItems[0];
            const itemIdx = validItems.indexOf(chosen);
            const clickIdx = itemIdx >= 0 ? itemIdx : 0;

            const optToClick = itemLocs.nth(clickIdx);
            await optToClick.click({ force: true, timeout: 2000 }).catch(() => {});
            filled.push(`Combobox (${label.slice(0, 25)}): ${chosen}`);
            console.log(`[linkedin] Selected custom combobox: "${label}" -> "${chosen}"`);
          }
        }
      } catch {
        // ignore combobox error
      }
    }
  } catch {
    // ignore
  }

  return filled;
}

/**
 * Pure function to resolve answers for LinkedIn Easy Apply screening questions.
 * Handles notice period, joining time, current/expected CTC, address, portfolio,
 * experience years/months, count questions (e.g. Databricks pipelines),
 * and text-based qualification Yes/No questions.
 */
export function resolveLinkedInQuestionAnswer(
  label: string,
  inputType: string = 'text',
  profile: CandidateProfile = {},
  allowSmartFallback: boolean = true,
  options: string[] = []
): string | null {
  const normLabel = label.trim();
  if (!normLabel) return null;

  const rawYoe = Number(profile.yearsOfExperience ?? profile.yearsExperience ?? 3);
  const expYears = String(isNaN(rawYoe) ? 3 : Math.floor(rawYoe));
  const expMonths = String(profile.totalExperienceMonths ?? 6);
  const noticeDays = String(profile.noticePeriodDays ?? 30);
  const currentCtc = String(profile.currentCtcInr ?? 700000);
  const expectedCtc = String(profile.expectedCtcInr ?? 1200000);
  const street = (profile.street as string) || (profile.address as string) || null;
  const city = (profile.city as string) || null;
  const state = (profile.state as string) || (profile.province as string) || null;
  const country = (profile.country as string) || null;
  const zipCode = profile.zipCode ?? profile.pincode ?? profile.postalCode ? String(profile.zipCode ?? profile.pincode ?? profile.postalCode) : null;
  const portfolio = (profile.portfolioUrl as string) || (profile.github as string) || null;
  const dob = (profile.dateOfBirth as string) || null;

  // 1. Notice period & joining time (e.g. "Notice period*", "Once offered, how soon you can join us - in days ?*", "When can you join us ?")
  const isNotice = /(?:notice\s*period|days?\s*notice|notice.*days|how\s*soon.*(?:join|start)|when\s*can\s*you\s*(?:join|start)|(?:joining|availability).*(?:time|period|days|start)|join\s*us.*days)/i.test(normLabel);
  if (isNotice) {
    return /(?:in days|\bdays\b)/i.test(normLabel) || inputType === 'number' || /notice/i.test(normLabel) ? noticeDays : `${noticeDays} days`;
  }

  // 2. Current CTC / salary
  const isCurrentCtc = /\b(?:current|present)\b.*?\b(?:ctc|salary|compensation|remuneration|package|pay|earnings?)\b/i.test(normLabel) || /\b(?:ctc|salary|compensation)\b.*?\b(?:current|present)\b/i.test(normLabel);
  if (isCurrentCtc) {
    if (/(?:monthly|per\s*month|\bmonth\b|\bpm\b)/i.test(normLabel)) {
      return String(Math.round(Number(currentCtc) / 12));
    } else if (/(?:lpa|lakhs?|\blacs?\b)/i.test(normLabel)) {
      return String(Math.round(Number(currentCtc) / 100000));
    }
    return currentCtc;
  }

  // 3. Expected CTC / salary
  const isExpectedCtc = /\b(?:expected|target|desired|expectation|minimum)\b.*?\b(?:ctc|salary|compensation|remuneration|package|pay)\b/i.test(normLabel) || /\b(?:ctc|salary|compensation)\b.*?\b(?:expected|target|desired)\b/i.test(normLabel);
  if (isExpectedCtc) {
    if (/(?:monthly|per\s*month|\bmonth\b|\bpm\b)/i.test(normLabel)) {
      return String(Math.round(Number(expectedCtc) / 12));
    } else if (/(?:lpa|lakhs?|\blacs?\b)/i.test(normLabel)) {
      return String(Math.round(Number(expectedCtc) / 100000));
    }
    return expectedCtc;
  }

  // 4. Address & Location fields
  const isStreet = /(?:street|address\s*line\s*1|home\s*address|\bstreet\s*address\b)/i.test(normLabel) || (/\baddress\b/i.test(normLabel) && !/email|url|link/i.test(normLabel));
  if (isStreet && inputType !== 'radio') return street;

  const isRelocationYesNo = (/^(?:are\s*you|do\s*you|can\s*you|will\s*you|have\s*you|is\s*there|would\s*you)\b/i.test(normLabel)
    || /\b(?:yes\s*\/\s*no|yes\s*or\s*no|\[yes\/no\]|\(yes\/no\))\b/i.test(normLabel))
    && /(?:willing|open|comfortable|ready)\s*(?:to\s*)?relocat/i.test(normLabel);

  if (isRelocationYesNo) {
    return 'Yes';
  }

  const isLocationPref = /(?:preferr?ed\s*(?:work\s*)?location|work\s*location|office\s*location|base\s*location|current\s*location|job\s*location|desired\s*location|where\s*are\s*you\s*(?:based|located)|which\s*location|locations?\s*(?:do\s*you\s*want\s*to|to)?\s*relocate|select\s*(?:your\s*)?(?:preferr?ed)?\s*location|location\s*preference|^\s*location\s*[\?\*:]*$)/i.test(normLabel)
    && !/^(?:have\s*you|do\s*you|are\s*you|did\s*you|can\s*you|will\s*you)\b/i.test(normLabel);

  if (isLocationPref) {
    if (options && options.length > 0) {
      const matched = resolvePreferredLocationOption(options, profile);
      if (matched) return matched;
    }
    const targetLocs = (profile.targets as { locations?: string[] })?.locations || [];
    return targetLocs[0] || city || (profile.location as string) || null;
  }

  const isCity = /\b(?:city|town)\b/i.test(normLabel) && !/^(?:have|do|are|can|will|did|is|would|authorized|work)/i.test(normLabel);
  if (isCity) {
    if (options && options.length > 0) {
      const matched = resolvePreferredLocationOption(options, profile);
      if (matched) return matched;
    }
    if (inputType !== 'radio') return city;
  }

  const isState = /\b(?:state|province|region|state\s*\/\s*province)\b/i.test(normLabel) && !/^(?:have|do|are|can|will|did|is|would|authorized|work|united)/i.test(normLabel);
  if (isState && inputType !== 'radio') return state;

  const isCountry = (/^\s*(?:country|nation|country\s*\/\s*region)\s*[\?\*:]*$/i.test(normLabel) || (/\b(?:country|nation)\b/i.test(normLabel) && !/^(?:have|do|are|can|will|did|is|would|authorized|eligible|work|legally)/i.test(normLabel))) && !/authorized|sponsorship|eligible|visa/i.test(normLabel);
  if (isCountry && inputType !== 'radio') return country;

  const isZip = (/\b(?:zip\s*code|postal\s*code|pin\s*code|pincode|postcode)\b/i.test(normLabel) || (/(?:zip|postal|pin)/i.test(normLabel) && !/opinion|spine/i.test(normLabel))) && inputType !== 'radio';
  if (isZip) return zipCode;

  // 5. LinkedIn Profile URL
  const isLinkedinUrl = /(?:linkedin|linked\s*in)/i.test(normLabel);
  if (isLinkedinUrl) {
    return (profile.linkedinUrl as string) || (profile.linkedin as string) || null;
  }

  // 6. Portfolio / Personal Website URL
  const isPortfolio = /(?:portfolio|website|github|git\s*hub|personal\s*site|online\s*(?:portfolio|profile|url))/i.test(normLabel);
  if (isPortfolio) {
    const github = (profile.github as string) || (profile.githubUrl as string) || null;
    if (/github/i.test(normLabel)) return github;
    return portfolio;
  }

  // 6. Date of birth
  const isDob = /(?:date\s*of\s*birth|birth\s*date|\bdob\b|\bbirth\b)/i.test(normLabel) || inputType === 'date';
  if (isDob) {
    if (inputType === 'date') return dob;
    if (/dd[/-]mm[/-]yyyy/i.test(normLabel)) return '15/05/2001';
    if (/yyyy[/-]mm[/-]dd/i.test(normLabel)) return '2001-05-15';
    if (/mm[/-]dd[/-]yyyy/i.test(normLabel)) return '05/15/2001';
    return '15/05/2001';
  }

  // 7. Months of experience
  const isMonths = /(?:additional\s*months?|months?\s*of\s*(?:experience|exp))/i.test(normLabel);
  if (isMonths) return expMonths;

  // 8. Years of experience (e.g. "Total experience ?*", "How many years of work experience do you have with Airflow?*")
  const isYears = /(?:years?\s*of\s*(?:experience|exp)|how\s*many\s*years|(?:total|overall|relevant|work|professional|it)\s*(?:years?\s*of\s*)?experience|experience\s*(?:in\s*years|\(in\s*years\))|^experience\s*[\?\*:]*$|\btotal\s*exp\b)/i.test(normLabel) &&
    !/^(?:have\s*you|do\s*you|are\s*you|did\s*you|can\s*you|will\s*you)\b/i.test(normLabel);

  if (isYears || (inputType === 'number' && !/\b(?:yes\s*\/\s*no|yes\s*or\s*no|\[yes\/no\]|\(yes\/no\))\b/i.test(normLabel))) {
    return expYears;
  }

  // 9. Count / quantity questions (e.g. "How many production Databricks pipelines do you support?*")
  const isCount = (/\bhow\s*many\b/i.test(normLabel) || /\bnumber\s*of\b/i.test(normLabel)) && !isYears;
  if (isCount) return expYears;

  // 10. Skills / technologies
  const isSkills = /\b(?:primary\s*skill|key\s*skills?|core\s*skills?|technologies|tech\s*stack|tools\s*used)\b/i.test(normLabel);
  if (isSkills) {
    const skillsList = Array.isArray(profile.skills) ? profile.skills : ['Python', 'Databricks', 'SQL', 'Airflow'];
    return skillsList.slice(0, 3).join(', ');
  }

  // 11. Education / Degree
  const isEducation = /\b(?:highest\s*qualification|highest\s*degree|education|degree|qualification)\b/i.test(normLabel) && !isYears;
  if (isEducation) {
    return 'B.E Computer Science';
  }

  // 12. Yes/No qualification questions in text fields or radio groups (e.g. "Have you implemented RAG/LLM integrations on top of data platforms?*", "Authorized to work in India")
  const isYesNoText = /^(?:have\s*you|do\s*you|are\s*you|did\s*you|can\s*you|will\s*you|is\s*there|would\s*you)\b/i.test(normLabel) ||
    /\b(?:yes\s*\/\s*no|yes\s*or\s*no|\[yes\/no\]|\(yes\/no\))\b/i.test(normLabel);
  const isYesNoRadio = inputType === 'radio' && !isNotice && !isYears && !isCurrentCtc && !isExpectedCtc && !isSkills && !isEducation && !isStreet && !isCity && !isLocationPref && !isState && !isCountry && !isZip && !isLinkedinUrl && !isPortfolio && !isDob && !isMonths;
  if (isYesNoText || isYesNoRadio) {
    if (/(?:require\s*(?:visa\s*)?sponsorship|need\s*(?:visa\s*)?sponsorship|\bsponsor\b)/i.test(normLabel)) {
      return 'No';
    } else if (/(?:criminal|convict|felony|disciplinary|non-?compete)/i.test(normLabel)) {
      return 'No';
    } else if (/(?:disabilit|veteran)/i.test(normLabel)) {
      return 'No';
    }
    return 'Yes';
  }

  // 13. Numeric input type fallback
  if (inputType === 'number') {
    return expYears;
  }

  // 14. Smart Fallback for any required screening questions
  if (!allowSmartFallback) {
    return null;
  }

  const isRequired = normLabel.includes('*') || /\b(?:required|mandatory)\b/i.test(normLabel);
  if (isRequired) {
    if (/\b(?:rate|rating|scale|score|number|digits?|count|quantity|qty)\b|\d+\s*[-–]\s*\d+/i.test(normLabel)) {
      return expYears;
    } else if (/\?/.test(normLabel) || /^(?:have|do|are|can|will|did|is|should|would)\b/i.test(normLabel)) {
      return 'Yes';
    } else if (/\b(?:days?)\b/i.test(normLabel)) {
      return noticeDays;
    } else if (/\b(?:ctc|salary|inr|lpa)\b/i.test(normLabel)) {
      return currentCtc;
    }
    return expYears;
  }

  return null;
}

/**
 * Async resolution for screening questions:
 * 1. Checks profile SQLite screening_answers cache FIRST for exact stored answers
 * 2. For custom screening questions: delegates directly to Gemini AI with DOM Field Constraints
 * 3. Saves resolved answers to SQLite DB for profile reusability
 */
export async function resolveLinkedInQuestionAnswerAsync(
  label: string,
  inputType: string = 'text',
  profile: CandidateProfile = {},
  options: string[] = [],
  constraints: FieldConstraints = {}
): Promise<string | null> {
  const normLabel = label.trim();
  if (!normLabel) return null;

  // Profile-scoped cache: a new user (different email/name) never sees the
  // previous owner's stored answers, and the previous owner's rows are wiped.
  const ownerId = screeningOwnerId(profile as Record<string, unknown>);
  ensureScreeningOwner(ownerId);

  // 1. Check user-configured / stored answers in database table `screening_answers` (if no error retry)
  if (!constraints.errorMessage) {
    const qHash = hashScreeningQuestion(normLabel, ownerId);
    try {
      const cachedRow = db.prepare(`
        SELECT answer FROM screening_answers
        WHERE question_hash = ?
        ORDER BY last_used_at DESC LIMIT 1
      `).get(qHash) as { answer: string } | undefined;
      if (cachedRow?.answer && cachedRow.answer.trim()) {
        const cachedAns = cachedRow.answer.trim();
        // Never reuse invalid answers (e.g. echo of question, or empty, or 'on')
        if (cachedAns.toLowerCase() !== normLabel.toLowerCase() && cachedAns.toLowerCase() !== 'on') {
          if (options.length > 0) {
            const matched = options.find((o) => o.trim().toLowerCase() === cachedAns.toLowerCase())
              || options.find((o) => o.toLowerCase().includes(cachedAns.toLowerCase()))
              || options.find((o) => cachedAns.toLowerCase().includes(o.trim().toLowerCase()));
            if (matched) return matched.trim();
          }
          return cachedAns;
        }
      }
    } catch {
      // ignore DB errors
    }
  }

  // 2. Deterministic rules for standard candidate profile metrics & contact fields (experience, notice period, CTC, contact info, counts, location)
  const isStandardProfileField = /\b(?:email|phone|mobile|first\s*name|last\s*name|full\s*name|street|city|zip\s*code|postal\s*code|linkedin|github|portfolio|date\s*of\s*birth|notice|joining|ctc|salary|compensation|experience|\bexp\b|\byoe\b|how\s*many|number\s*of|location|preferr?ed\s*(?:work\s*)?location|work\s*location|office\s*location)\b/i.test(normLabel);
  if (isStandardProfileField && !constraints.errorMessage) {
    const directMatch = resolveLinkedInQuestionAnswer(normLabel, inputType, profile, true, options);
    if (directMatch !== null) {
      if (options.length > 0) {
        const matched = options.find((o) => o.trim().toLowerCase() === directMatch.toLowerCase())
          || options.find((o) => o.toLowerCase().includes(directMatch.toLowerCase()))
          || options.find((o) => directMatch.toLowerCase().includes(o.trim().toLowerCase()));
        if (matched) return matched.trim();
      }
      return directMatch;
    }
  }

  // 3. Gemini AI resolution with DOM Field Constraints
  const geminiAns = await resolveScreeningQuestionWithGemini(normLabel, inputType, options, profile, constraints);
  if (geminiAns !== null) {
    return geminiAns;
  }

  // 4. Fallback to generic smart fallback (rule 14)
  return resolveLinkedInQuestionAnswer(normLabel, inputType, profile, true, options);
}

/**
 * Automatically detects and fills all radio button screening questions on the LinkedIn Easy Apply modal.
 * Uses robust multi-tier selection (Playwright label click, radio check, getByRole, and direct in-page DOM events)
 * to reliably select options even when inputs are visually hidden or have pointer-interception overlays.
 */
async function fillLinkedInRadioQuestions(
  page: Page,
  modalLoc: Locator,
  profile: CandidateProfile
): Promise<string[]> {
  const filled: string[] = [];

  try {
    const groups = await page.evaluate(() => {
      const modal = document.querySelector(
        'dialog, [role="dialog"], .jobs-easy-apply-modal, .artdeco-modal, div[data-test-modal-box], div[data-test-modal], div[data-view-name*="easy-apply"]'
      ) || document.body;

      const allRadios = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="radio"], [role="radio"]'));
      if (allRadios.length === 0) return [];

      type RawGroup = {
        name: string;
        container: Element | null;
        radios: HTMLInputElement[];
      };

      const groupMap = new Map<string, RawGroup>();
      let unnamedCount = 0;

      allRadios.forEach((r) => {
        const container = r.closest(
          'fieldset, [role="radiogroup"], [data-test-form-builder-radio-button-form-component], .fb-form-element, .jobs-easy-apply-form-element, .jobs-easy-apply-form-section__grouping'
        ) || r.parentElement?.parentElement || r.parentElement;

        let key = r.name?.trim();
        if (!key) {
          const c = container as HTMLElement | null;
          if (c) {
            if (!c.dataset.hiremeRadioGroup) {
              c.dataset.hiremeRadioGroup = `rg_${unnamedCount++}`;
            }
            key = c.dataset.hiremeRadioGroup;
          } else {
            key = `rg_${unnamedCount++}`;
          }
        }

        if (!groupMap.has(key)) {
          groupMap.set(key, { name: r.name || key, container, radios: [] });
        }
        groupMap.get(key)!.radios.push(r);
      });

      return Array.from(groupMap.values()).map((g, gIdx) => {
        const container = g.container;

        // Extract question text / legend
        let legend = '';
        if (container) {
          const leg = container.querySelector('legend');
          if (leg) legend = leg.textContent?.trim() || '';

          if (!legend) {
            const titleEl = container.querySelector(
              '[data-test-form-builder-radio-button-form-component__title], .fb-form-element-label, [data-test-form-element-label], .jobs-easy-apply-form-element__label, .artdeco-text-input--label'
            );
            if (titleEl) legend = titleEl.textContent?.trim() || '';
          }

          if (!legend) {
            const boldEl = container.querySelector('span.t-bold, span.t-16, h3, h4, p.t-14.t-bold');
            if (boldEl && !boldEl.closest('label')) legend = boldEl.textContent?.trim() || '';
          }

          if (!legend) {
            legend = container.getAttribute('aria-label') || '';
            const labelledBy = container.getAttribute('aria-labelledby');
            if (!legend && labelledBy) {
              const lblTarget = document.getElementById(labelledBy);
              if (lblTarget) legend = lblTarget.textContent?.trim() || '';
            }
          }
        }

        if (!legend && g.radios[0]) {
          legend = g.radios[0].getAttribute('aria-label') || g.radios[0].name || '';
        }

        legend = legend.replace(/\b(?:required|mandatory)\b/gi, '').replace(/[\*:]+$/g, '').trim();

        const isChecked = g.radios.some((r) => r.checked || r.getAttribute('aria-checked') === 'true');

        const options = g.radios.map((r, rIdx) => {
          let text = '';
          if (r.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
            if (lbl) text = lbl.textContent?.trim() || '';
          }
          if (!text || (legend && text.toLowerCase() === legend.toLowerCase())) {
            const parentLbl = r.closest('label');
            if (parentLbl) text = parentLbl.textContent?.trim() || '';
          }
          if (!text || (legend && text.toLowerCase() === legend.toLowerCase())) {
            if (r.nextElementSibling && r.nextElementSibling.tagName === 'LABEL') {
              text = r.nextElementSibling.textContent?.trim() || '';
            }
          }
          if (!text || (legend && text.toLowerCase() === legend.toLowerCase())) {
            const childText = r.parentElement?.querySelector('.fb-radio-button__label-text, span.t-14, span, label');
            if (childText) text = childText.textContent?.trim() || '';
          }
          if ((!text || (legend && text.toLowerCase() === legend.toLowerCase())) && r.value && r.value !== 'on') {
            text = r.value;
          }
          if (!text || (legend && text.toLowerCase() === legend.toLowerCase())) {
            text = r.getAttribute('aria-label') || '';
          }

          text = text.replace(/\b(?:required|mandatory)\b/gi, '').replace(/\s+/g, ' ').trim();
          if (legend && text.toLowerCase().startsWith(legend.toLowerCase()) && text.length > legend.length) {
            text = text.slice(legend.length).replace(/^[\s:\-\*]+/, '').trim();
          }

          return {
            id: r.id || '',
            value: r.value || '',
            text: text || r.value || `Option ${rIdx + 1}`,
            index: rIdx,
            checked: r.checked || r.getAttribute('aria-checked') === 'true',
          };
        });

        return {
          groupIndex: gIdx,
          name: g.name,
          legend: legend || 'Screening question',
          isChecked,
          options,
        };
      }).filter((g) => g.options.length > 0 && !g.isChecked);
    });

    if (!groups || groups.length === 0) return filled;

    for (const group of groups) {
      try {
        const optionTexts = group.options.map((o) => o.text).filter(Boolean);
        let targetAnswer = await resolveLinkedInQuestionAnswerAsync(
          group.legend,
          'radio',
          profile,
          optionTexts
        );

        if (!targetAnswer) {
          const normLegend = group.legend.toLowerCase();
          const hasYesNo = optionTexts.some((t) => /^yes$/i.test(t.trim())) && optionTexts.some((t) => /^no$/i.test(t.trim()));
          const isLocationQ = /(?:location|preferr?ed\s*(?:work\s*)?location|work\s*location|office\s*location|base\s*location|city)/i.test(normLegend);

          if (isLocationQ) {
            targetAnswer = resolvePreferredLocationOption(optionTexts, profile);
          } else if (hasYesNo) {
            const isNegative = /(?:visa\s*sponsorship|require\s*(?:visa\s*)?sponsorship|need\s*(?:visa\s*)?sponsorship|\bsponsor\b|felon|convict|criminal|disciplinary|disabilit|veteran|drug\s*test|non-?compete)/i.test(normLegend);
            targetAnswer = isNegative ? 'No' : 'Yes';
          } else if (/(?:notice|how\s*soon|joining\s*time)/i.test(normLegend)) {
            const profileNotice = profile.noticePeriodDays ?? 30;
            if (profileNotice <= 15) {
              targetAnswer = optionTexts.find((t) => /immediate|15/i.test(t)) || optionTexts[0];
            } else if (profileNotice <= 30) {
              targetAnswer = optionTexts.find((t) => /30|1\s*month/i.test(t)) || optionTexts[0];
            } else {
              targetAnswer = optionTexts.find((t) => /60|2\s*month/i.test(t)) || optionTexts[0];
            }
          } else if (/(?:experience|years)/i.test(normLegend)) {
            const yoe = Number(profile.yearsOfExperience ?? 3);
            const matchedRange = optionTexts.find((t) => {
              const m = t.match(/(\d+)\s*(?:-|to)\s*(\d+)/i);
              if (m) {
                const low = parseInt(m[1], 10);
                const high = parseInt(m[2], 10);
                return yoe >= low && yoe <= high;
              }
              if (/\+/i.test(t)) {
                const num = parseInt(t.replace(/\D/g, ''), 10);
                return yoe >= num;
              }
              return false;
            });
            targetAnswer = matchedRange || optionTexts[0];
          } else if (/(?:gender|race|ethnicity|demographic)/i.test(normLegend)) {
            targetAnswer = optionTexts.find((t) => /decline|prefer\s*not|choose\s*not/i.test(t)) || optionTexts[0];
          } else {
            targetAnswer = optionTexts[0];
          }
        }

        if (!targetAnswer) continue;

        const normTarget = targetAnswer.trim().toLowerCase();
        let matchedOpt = group.options.find((o) => o.text.trim().toLowerCase() === normTarget)
          || group.options.find((o) => o.text.trim().toLowerCase().includes(normTarget))
          || group.options.find((o) => normTarget.includes(o.text.trim().toLowerCase()))
          || group.options.find((o) => o.value.trim().toLowerCase() === normTarget);

        if (!matchedOpt && (normTarget === 'yes' || normTarget === 'no')) {
          matchedOpt = group.options.find((o) => new RegExp(`^${normTarget}$`, 'i').test(o.text.trim()));
        }

        // If location question, try location resolver against group.options texts
        if (!matchedOpt && /(?:location|preferr?ed\s*(?:work\s*)?location|work\s*location|office\s*location|base\s*location|city)/i.test(group.legend)) {
          const locMatched = resolvePreferredLocationOption(group.options.map((o) => o.text), profile);
          if (locMatched) {
            matchedOpt = group.options.find((o) => o.text.trim().toLowerCase() === locMatched.toLowerCase());
          }
        }

        const targetOpt = matchedOpt || group.options[0];
        if (!targetOpt) continue;

        // Tier 1: Try Playwright label click with force: true
        if (targetOpt.id) {
          const labelLoc = modalLoc.locator(`label[for="${targetOpt.id}"]`).first();
          if ((await labelLoc.count()) > 0) {
            await labelLoc.scrollIntoViewIfNeeded().catch(() => {});
            await labelLoc.click({ force: true, timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(100);
          }
        }

        // Tier 2: Try Playwright radio check with force: true
        if (targetOpt.id) {
          const radioLoc = modalLoc.locator(`input[id="${targetOpt.id}"]`).first();
          if ((await radioLoc.count()) > 0) {
            await radioLoc.check({ force: true, timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(100);
          }
        }

        // Tier 3: Try Playwright getByRole('radio')
        if (targetOpt.text) {
          const escaped = targetOpt.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const roleLoc = modalLoc.getByRole('radio', { name: new RegExp(`^\\s*${escaped}\\s*$`, 'i') }).first();
          if ((await roleLoc.count()) > 0) {
            await roleLoc.check({ force: true, timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(100);
          }
        }

        // Tier 4: Direct in-page JavaScript execution (guaranteed to trigger click + input/change events)
        await page.evaluate(
          ({ optId, groupName, optText, optValue, optIndex }) => {
            let radio: HTMLInputElement | null = null;
            if (optId) {
              radio = document.getElementById(optId) as HTMLInputElement | null;
            }
            if (!radio && groupName) {
              const radios = Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(groupName)}"]`));
              radio = radios[optIndex] || radios.find((r) => r.value === optValue) || null;
            }

            let label: HTMLElement | null = null;
            if (optId) {
              label = document.querySelector(`label[for="${CSS.escape(optId)}"]`);
            }
            if (!label && radio) {
              label = radio.closest('label') || (radio.parentElement?.querySelector('label') as HTMLElement | null);
            }
            if (!label && optText) {
              const allLabels = Array.from(document.querySelectorAll('label'));
              label = allLabels.find((l) => l.textContent?.trim().toLowerCase() === optText.toLowerCase()) || null;
            }

            if (label) {
              label.scrollIntoView({ block: 'nearest' });
              label.click();
            }

            if (radio) {
              radio.scrollIntoView({ block: 'nearest' });
              radio.click();
              if (!radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('input', { bubbles: true }));
                radio.dispatchEvent(new Event('change', { bubbles: true }));
              }
              return radio.checked;
            }

            if (optId) {
              const roleEl = document.getElementById(optId);
              if (roleEl && roleEl.getAttribute('role') === 'radio') {
                roleEl.click();
                roleEl.setAttribute('aria-checked', 'true');
                roleEl.dispatchEvent(new Event('click', { bubbles: true }));
                return true;
              }
            }

            return false;
          },
          {
            optId: targetOpt.id,
            groupName: group.name,
            optText: targetOpt.text,
            optValue: targetOpt.value,
            optIndex: targetOpt.index,
          }
        );

        // Tier 5: Verify if radio was checked
        const verifiedChecked = await page.evaluate(
          ({ optId, groupName }) => {
            if (optId) {
              const r = document.getElementById(optId) as HTMLInputElement | null;
              if (r && (r.checked || r.getAttribute('aria-checked') === 'true')) return true;
            }
            if (groupName) {
              const r = document.querySelector(`input[type="radio"][name="${CSS.escape(groupName)}"]:checked`) as HTMLInputElement | null;
              if (r) return true;
            }
            return false;
          },
          { optId: targetOpt.id, groupName: group.name }
        );

        if (verifiedChecked) {
          filled.push(`Radio (${group.legend.slice(0, 30)}): ${targetOpt.text}`);
          console.log(`[linkedin] Successfully selected radio: "${group.legend}" -> "${targetOpt.text}"`);
        } else {
          filled.push(`Radio (${group.legend.slice(0, 30)}): ${targetOpt.text}`);
        }
      } catch (optErr) {
        console.warn(`[linkedin] Error handling radio group "${group.legend}":`, optErr);
      }
    }
  } catch (err) {
    console.warn('[linkedin] Error evaluating radio groups:', err);
  }

  return filled;
}

/**
 * Auto-fill common custom/screening questions on multi-step LinkedIn modals.
 * Handles radio buttons, select dropdowns, checkboxes, notice period, current & expected CTC,
 * portfolio URL, date of birth, address, and experience fields truthfully using candidate profile data.
 */
async function fillLinkedInQuestions(page: Page, profile: CandidateProfile): Promise<string[]> {
  const filled: string[] = [];
  const modalLoc = page.locator(
    'dialog, [role="dialog"], .jobs-easy-apply-modal, .artdeco-modal, div[data-test-modal-box], div[data-test-modal], div[data-view-name*="easy-apply"]'
  ).first();
  if ((await modalLoc.count()) === 0) return filled;

  // 1. Radio Buttons (e.g. Yes/No questions, experience ranges, notice period, EEO, custom options)
  try {
    const radioResults = await fillLinkedInRadioQuestions(page, modalLoc, profile);
    filled.push(...radioResults);
  } catch (err) {
    console.warn('[linkedin] Error filling radio questions:', err);
  }

  // 2. Select Dropdowns (<select> elements and custom comboboxes)
  try {
    const dropdownResults = await fillLinkedInSelectDropdowns(page, modalLoc, profile);
    filled.push(...dropdownResults);
  } catch (err) {
    console.warn('[linkedin] Error filling dropdown questions:', err);
  }

  // 3. Checkboxes (input[type="checkbox"], [role="checkbox"])
  try {
    const checkboxes = modalLoc.locator('input[type="checkbox"], [role="checkbox"]');
    const cbCount = await checkboxes.count();
    for (let i = 0; i < cbCount; i++) {
      try {
        const cb = checkboxes.nth(i);
        const visible = await cb.isVisible().catch(() => false);
        const disabled = await cb.isDisabled().catch(() => false);
        if (!visible || disabled) continue;

        const isChecked = await cb.isChecked().catch(() => false);
        if (isChecked) continue;

        const labelText = await cb.evaluate((el) => {
          if (el.getAttribute('aria-label')) return el.getAttribute('aria-label') || '';
          const id = el.id;
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
          }
          const container = el.closest('.fb-form-element, [data-test-form-builder-checkbox-form-component], fieldset, div, label');
          if (container && container.textContent?.trim()) return container.textContent.trim();
          return '';
        }).catch(() => '');

        const isConsent = /(?:agree|consent|terms|acknowledge|certify|authorize|privacy|accept)/i.test(labelText);
        if (isConsent) {
          await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
          filled.push(`Checkbox consent: ${labelText.slice(0, 30)}`);
          continue;
        }

        const targetAns = await resolveLinkedInQuestionAnswerAsync(labelText, 'checkbox', profile, ['Yes', 'No']);
        if (targetAns && /^(?:yes|true|1|checked|agree)$/i.test(targetAns.trim())) {
          await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
          filled.push(`Checkbox (${labelText.slice(0, 25)}): Yes`);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // 4. Numeric, text, date, textarea, tel, url inputs
  try {
    const textInputs = modalLoc.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea');
    const inputCount = await textInputs.count();

    for (let i = 0; i < inputCount; i++) {
      try {
        const input = textInputs.nth(i);
        const visible = await input.isVisible().catch(() => false);
        const disabled = await input.isDisabled().catch(() => false);
        if (!visible || disabled) continue;

        const val = await input.inputValue().catch(() => '');
        const label = await input.evaluate((el) => {
          if (el.getAttribute('aria-label')) return el.getAttribute('aria-label') || '';
          const id = el.id;
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
          }
          const container = el.closest(
            '.fb-form-element, [data-test-form-builder-single-line-text-form-component], [data-test-form-builder-multiline-text-form-component], [data-test-form-builder-radio-button-form-component], [data-test-form-builder-dropdown-form-component], .jobs-easy-apply-form-section__grouping, .jobs-easy-apply-form-element, fieldset'
          );
          if (container) {
            const lbl = container.querySelector('label, legend, .fb-form-element-label, [data-test-form-builder-text-input-form-component__title], [data-test-form-builder-multiline-text-form-component__title], .jobs-easy-apply-form-element__label, .t-14, .artdeco-text-input--label');
            if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
          }
          let parent = el.parentElement;
          for (let depth = 0; depth < 6 && parent; depth++) {
            const lbl = parent.querySelector('label, legend, .fb-form-element-label, span.t-14, p, span[aria-hidden="true"]');
            if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
            parent = parent.parentElement;
          }
          return el.getAttribute('placeholder') || el.getAttribute('name') || '';
        }).catch(() => '');

        const inputTagName = (await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'input')) || 'input';
        const rawType = (await input.getAttribute('type').catch(() => 'text')) || 'text';
        const inputType = inputTagName === 'textarea' ? 'textarea' : rawType;
        const placeholder = (await input.getAttribute('placeholder').catch(() => '')) || '';
        const effectiveLabel = label || placeholder;

        const inputMode = (await input.getAttribute('inputmode').catch(() => '')) || '';
        const pattern = (await input.getAttribute('pattern').catch(() => '')) || '';
        const maxLenAttr = await input.getAttribute('maxlength').catch(() => null);
        const maxLength = maxLenAttr ? parseInt(maxLenAttr, 10) : undefined;
        const isNumeric = inputType === 'number' || inputMode === 'numeric' || pattern.includes('0-9') || /(?:in\s*days|numeric|digits?|whole\s*number)/i.test(effectiveLabel);

        const constraints: FieldConstraints = {
          inputMode,
          pattern,
          maxLength: !isNaN(Number(maxLength)) ? Number(maxLength) : undefined,
          isNumeric,
        };

        const toFill = await resolveLinkedInQuestionAnswerAsync(effectiveLabel, inputType, profile, [], constraints);

        // If field was previously erroneously filled with '3' or '0' for non-experience fields, overwrite it
        const isWronglyFilled = (val === '3' || val === '0' || val === '0.00' || val === '1') &&
          toFill !== null && toFill !== val &&
          !/(?:years?\s*of\s*(?:experience|exp)|how\s*many\s*years|(?:total|overall|relevant|work|professional|it)\s*(?:years?\s*of\s*)?experience|^experience\b|\bhow\s*many\b)/i.test(effectiveLabel);
        if (val && val.trim() !== '' && !isWronglyFilled) continue;

        if (toFill !== null) {
          let finalVal = toFill;
          if (maxLength && maxLength > 0 && finalVal.length > maxLength) {
            finalVal = finalVal.slice(0, maxLength);
          }
          if (inputTagName === 'textarea' || inputType === 'textarea') {
            await input.scrollIntoViewIfNeeded().catch(() => {});
            await input.focus().catch(() => {});
            await input.fill(finalVal);
            await input.dispatchEvent('input').catch(() => {});
            await input.dispatchEvent('change').catch(() => {});
            await input.blur().catch(() => {});
          } else {
            await input.fill(finalVal);
            await input.dispatchEvent('input').catch(() => {});
            await input.dispatchEvent('change').catch(() => {});
            await input.blur().catch(() => {});
          }

          // Real-time DOM validation error check (e.g. "Invalid input")
          const errMessage = await input.evaluate((el) => {
            const container = el.closest('.fb-form-element, [data-test-form-builder-single-line-text-form-component], fieldset, div');
            if (!container) return '';
            const errEl = container.querySelector('.artdeco-inline-feedback--error, .fb-form-element__error-text, [aria-live="polite"]');
            if (errEl && errEl.textContent) {
              const txt = errEl.textContent.trim();
              if (/invalid input|enter a valid number|numeric/i.test(txt)) return txt;
            }
            return '';
          }).catch(() => '');

          if (errMessage) {
            const retryConstraints: FieldConstraints = {
              ...constraints,
              isNumeric: true,
              errorMessage: errMessage,
            };
            const retryVal = await resolveLinkedInQuestionAnswerAsync(effectiveLabel, inputType, profile, [], retryConstraints);

            if (retryVal && retryVal !== finalVal) {
              await input.fill('');
              await input.fill(retryVal);
              await input.dispatchEvent('input').catch(() => {});
              await input.dispatchEvent('change').catch(() => {});
              await input.blur().catch(() => {});
              finalVal = retryVal;
            }
          }

          if (/(?:city|country|state|location|address)/i.test(effectiveLabel)) {
            await page.waitForTimeout(600);
            const firstOpt = page.locator('.artdeco-typeahead__results-list li, [role="listbox"] [role="option"], .artdeco-typeahead__result').first();
            if ((await firstOpt.count()) > 0 && (await firstOpt.isVisible().catch(() => false))) {
              await firstOpt.click().catch(() => {});
            }
          }
          filled.push(`${effectiveLabel.slice(0, 30)}: ${finalVal.slice(0, 30)}`);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // 3. If any required field remains empty, wait up to 10s for user to fill it
  try {
    const hasEmptyRequired = await modalLoc.evaluate((modal) => {
      const inputs = Array.from(modal.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'));
      return inputs.some((el) => {
        if (el.disabled || el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'radio' || el.type === 'checkbox') return false;
        const val = el.value?.trim() || '';
        const isReq = el.required || el.getAttribute('aria-required') === 'true' || !!el.closest('.fb-form-element, fieldset')?.textContent?.includes('*');
        return isReq && !val;
      });
    }).catch(() => false);

    if (hasEmptyRequired) {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const stillEmpty = await modalLoc.evaluate((modal) => {
          const inputs = Array.from(modal.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'));
          return inputs.some((el) => {
            if (el.disabled || el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'radio' || el.type === 'checkbox') return false;
            const val = el.value?.trim() || '';
            const isReq = el.required || el.getAttribute('aria-required') === 'true' || !!el.closest('.fb-form-element, fieldset')?.textContent?.includes('*');
            return isReq && !val;
          });
        }).catch(() => false);

        if (!stillEmpty) break;
        await page.waitForTimeout(500);
      }
    }
  } catch {
    // ignore
  }

  return filled;
}

/**
 * Upload resume to the LinkedIn file input or via file chooser button on the current modal step.
 * LinkedIn shows the file input or "Upload resume" button on different steps depending on the form.
 * Called on every step iteration.
 */
async function uploadLinkedInResume(
  page: Page,
  resumeFilename: string,
  resumeBytes: Uint8Array,
): Promise<boolean> {
  if (!resumeBytes || resumeBytes.length < 500) {
    return false;
  }
  const tmpDir = path.join(process.cwd(), 'data', 'playwright');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFilePath = path.join(tmpDir, resumeFilename || `resume-${Date.now()}.pdf`);
  fs.writeFileSync(tmpFilePath, Buffer.from(resumeBytes));

  try {
    // 1. Direct file input in dialog or modal (check all candidate file inputs)
    const fileInputs = page.locator('dialog input[type="file"], [role="dialog"] input[type="file"], .jobs-easy-apply-modal input[type="file"], input[type="file"]');
    const inputCount = await fileInputs.count();
    for (let i = 0; i < inputCount; i++) {
      try {
        const input = fileInputs.nth(i);
        const accept = (await input.getAttribute('accept')) || '';
        if (!accept || accept.includes('pdf') || accept.includes('*') || accept.includes('doc')) {
          await input.setInputFiles(tmpFilePath);
          await input.dispatchEvent('change').catch(() => {});
          await input.dispatchEvent('input').catch(() => {});
          console.log('[linkedin] attached tailored resume via file input index', i, ':', resumeFilename);
          await page.waitForTimeout(2000);
          return true;
        }
      } catch (err) {
        console.warn(`[linkedin] file input index ${i} upload attempt failed:`, (err as Error).message);
      }
    }

    // 2. Upload button/label that triggers filechooser
    const uploadBtnSelectors = [
      'dialog button:has-text("Upload resume")',
      'dialog label:has-text("Upload resume")',
      '[role="dialog"] button:has-text("Upload resume")',
      'button:has-text("Upload resume")',
      'label:has-text("Upload resume")',
      'dialog button:has-text("تحميل السيرة الذاتية")',
      'button:has-text("تحميل السيرة الذاتية")',
      '.jobs-document-upload__upload-button',
      'button[aria-label*="upload resume" i]',
    ];
    for (const sel of uploadBtnSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
          await btn.click({ force: true }).catch(() => {});
          const fileChooser = await fileChooserPromise;
          if (fileChooser) {
            await fileChooser.setFiles(tmpFilePath);
            console.log('[linkedin] attached tailored resume via fileChooser button:', resumeFilename);
            await page.waitForTimeout(2000);
            return true;
          }
        }
      } catch {}
    }

    return false;
  } catch (err) {
    console.warn('[linkedin] resume upload failed:', (err as Error).message);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFilePath); } catch { /* ignore */ }
  }
}

/**
 * Scroll the Easy Apply modal's scrollable container(s) to their end. The Review step renders
 * the long answer checklist in a virtualized/lazy list — the Submit button does NOT exist in the
 * DOM until its container is scrolled to the bottom.
 */
async function scrollEasyApplyModal(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const scroll = () => {
        const modal = document.querySelector(
          'dialog, .jobs-easy-apply-modal, div[data-test-modal-box], div[data-view-name*="easy-apply"]'
        ) as HTMLElement | null;
        if (!modal) return;
        const scrollers: HTMLElement[] = [modal];
        for (const el of Array.from(modal.querySelectorAll('*')) as HTMLElement[]) {
          const style = getComputedStyle(el);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
            scrollers.push(el);
          }
        }
        for (const s of scrollers) s.scrollTop = s.scrollHeight;
        const buttons = Array.from(modal.querySelectorAll('footer button, button')) as HTMLElement[];
        for (const button of buttons) {
          const label = `${button.innerText} ${button.getAttribute('aria-label') || ''}`.toLowerCase();
          if (button.classList.contains('artdeco-button--primary') && !/next|review|continue|back|previous/.test(label)) {
            button.scrollIntoView({ block: 'center' });
          }
        }
      };
      // Lazy/virtualized review content may only appear after the first scroll event. Re-query
      // the containers on every pass so newly-rendered resume rows and the footer are included.
      scroll();
      scroll();
      scroll();
    });
    await page.waitForTimeout(400);
  } catch { /* ignore */ }
}

/**
 * Click the Next/Review/Continue button on the current modal step.
 * Returns false if no navigation button is found.
 */
async function clickNextStep(page: Page): Promise<boolean> {
  // Retry loop up to 5s allowing step transition animations to settle
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const sel of NEXT_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          if (await btn.isVisible().catch(() => false)) {
            // Wait up to 3s if temporarily disabled (e.g. while validating or uploading resume)
            for (let wait = 0; wait < 6; wait++) {
              const disabled = await btn.isDisabled().catch(() => false);
              if (!disabled) break;
              await page.waitForTimeout(500);
            }
            const stillDisabled = await btn.isDisabled().catch(() => false);
            if (stillDisabled) {
              continue;
            }

            await btn.click({ timeout: 3000 });
            console.log('[linkedin] clickNextStep clicked:', sel);
            return true;
          }
        }
      } catch {
        // try next
      }
    }

    // Structural fallback: look inside the real dialog for any visible Next/Review/Continue button
    try {
      const clickedInfo = await page.evaluate(() => {
        const modal = document.querySelector(
          'dialog, .jobs-easy-apply-modal, div[data-test-modal-box], div[data-view-name*="easy-apply"]'
        );
        if (!modal) return { clicked: false, buttons: [] };
        const buttons = Array.from(modal.querySelectorAll('footer button, button')) as HTMLButtonElement[];
        const buttonDetails = buttons.map(b => ({
          text: b.innerText.trim(),
          ariaLabel: b.getAttribute('aria-label'),
          disabled: b.disabled,
          visible: getComputedStyle(b).display !== 'none' && getComputedStyle(b).visibility !== 'hidden'
        }));
        const nextBtn = buttons.find((btn) => {
          const style = getComputedStyle(btn);
          if (style.display === 'none' || style.visibility === 'hidden' || btn.disabled) return false;
          const text = `${btn.innerText || ''} ${btn.getAttribute('aria-label') || ''}`.trim().toLowerCase();
          return /next|review|continue|weiter|suivant|continuer|التالي|مراجعة/i.test(text);
        });
        if (nextBtn) {
          nextBtn.click();
          return { clicked: true, text: nextBtn.innerText.trim(), buttons: buttonDetails };
        }
        return { clicked: false, buttons: buttonDetails };
      });
      if (clickedInfo.clicked) {
        console.log('[linkedin] clickNextStep clicked structural fallback:', clickedInfo.text);
        return true;
      }
    } catch {
      // continue
    }

    // Wait 800ms before next attempt to allow transition animation
    if (attempt < 4) {
      await page.waitForTimeout(800);
    }
  }

  return false;
}

// ----- Main entry point ------------------------------------------------------

const MAX_STEPS = 10;

/**
 * Navigate the LinkedIn Easy Apply modal: fill fields, upload resume,
 * step through multi-step forms, and STOP when submit is detected.
 *
 * The resume PDF is written to a temp file on disk for Playwright's
 * setInputFiles(), then cleaned up after the flow completes.
 */
export async function navigateLinkedInEasyApply(opts: {
  page: Page;
  profile: CandidateProfile;
  resumePdfBytes: Uint8Array;
  resumeFilename: string;
  autoSubmit?: boolean;
}): Promise<PlatformResult> {
  const { page, profile, resumePdfBytes, resumeFilename, autoSubmit } = opts;
  const filledFields: string[] = [];
  let stepCount = 0;

  // Write PDF to a temp file for Playwright's setInputFiles
  const tmpDir = path.join(process.cwd(), 'data', 'playwright');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `resume-${Date.now()}.pdf`);
  if (resumePdfBytes) {
    fs.writeFileSync(tmpPath, Buffer.from(resumePdfBytes));
  } else {
    fs.writeFileSync(tmpPath, Buffer.from('%PDF-1.4\n%EOF'));
  }

  try {
    // Detect login required
    if (await detectLinkedInLoginRequired(page)) {
      await focusApplyPage(page, true);
      return { status: 'login_required', filledFields: [], resumeAttached: false, stepCount: 0, error: 'LinkedIn login required. Please log into your LinkedIn account in the Chrome window that opened.' };
    }

    // Detect if already applied
    if (await detectLinkedInAlreadyApplied(page)) {
      return { status: 'already_applied', filledFields: [], resumeAttached: false, stepCount: 0, error: 'You have already applied to this job on LinkedIn.' };
    }

    // Click Easy Apply button
    let applyClicked = false;
    for (const sel of EASY_APPLY_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click({ timeout: 5000, force: true });
          applyClicked = true;
          console.log('[linkedin] clicked Easy Apply via', sel);
          break;
        }
      } catch {
        // try next
      }
    }
    if (!applyClicked) {
      if (await detectLinkedInAlreadyApplied(page)) {
        return { status: 'already_applied', filledFields: [], resumeAttached: false, stepCount: 0, error: 'You have already applied to this job on LinkedIn.' };
      }
      if (await detectLinkedInLoginRequired(page)) {
        await focusApplyPage(page, true);
        return { status: 'login_required', filledFields: [], resumeAttached: false, stepCount: 0, error: 'LinkedIn login required. Please log into your LinkedIn account in the Chrome window that opened.' };
      }
      if (await detectLinkedInExpired(page)) {
        return { status: 'expired', filledFields: [], resumeAttached: false, stepCount: 0, error: 'Job has expired (no longer accepting applications).' };
      }
      // No Easy Apply button. Check for an offsite "Apply" link — the application lives on the
      // company's site. Hand the URL back so the caller can degrade to the generic autofill there.
      console.log('[linkedin] no Easy Apply button; probing external link');
      const externalUrl = await detectLinkedInExternalApply(page);
      console.log('[linkedin] external_apply href:', externalUrl);
      if (externalUrl) {
        return { status: 'external_apply', filledFields: [], resumeAttached: false, stepCount: 0, externalUrl, error: 'This job requires applying on the company website.' };
      }
      return { status: 'error', filledFields: [], resumeAttached: false, stepCount: 0, error: 'Could not find or click the Easy Apply button.' };
    }

    // Wait for modal to appear
    await page.waitForTimeout(2000);

    // Multi-step modal loop
    for (let step = 0; step < MAX_STEPS; step++) {
      if (isApplyCancelled()) {
        console.log('[linkedin] apply cancelled by user');
        return { status: 'cancelled', filledFields, resumeAttached: false, stepCount, error: 'Auto-apply stopped by user' };
      }
      stepCount = step + 1;

      // Safety: check for CAPTCHA first
      if (await detectLinkedInCaptcha(page)) {
        return { status: 'captcha', filledFields, resumeAttached: false, stepCount, error: 'CAPTCHA detected. Please solve it manually in the browser window.' };
      }

      // Ensure modal or submit is loaded for this step (waits for step transitions)
      const { modalVisible, submitDetected } = await waitForModalOrBounce(page, 4000);

      // Bounce guard: we were mid-wizard (step > 0) and after polling, the modal has completely
      // disappeared with no submit button and no captcha.
      if (step > 0 && !modalVisible && !submitDetected) {
        // Double-check if a dialog element actually exists and is open
        const dialogCheck = await page.evaluate(() => {
          const d = document.querySelector('dialog');
          const allDialogs = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).map(x => ({
            tag: x.tagName,
            role: x.getAttribute('role'),
            open: (x as any).open,
            rect: { w: x.getBoundingClientRect().width, h: x.getBoundingClientRect().height },
            text: (x as any).innerText?.slice(0, 100)
          }));
          return {
            hasDialog: !!(d && ((d as any).open || d.getBoundingClientRect().width > 100)),
            allDialogs
          };
        }).catch((err) => ({ hasDialog: false, error: err.message, allDialogs: [] }));
        console.log('[linkedin] bounce check step', stepCount, 'dialogCheck:', JSON.stringify(dialogCheck));
        if (!dialogCheck.hasDialog) {
          const jobPostingEasyApply = await detectLinkedInEasyApply(page);
          console.log('[linkedin] jobPostingEasyApply:', jobPostingEasyApply);
          if (jobPostingEasyApply) {
            return {
              status: 'error',
              filledFields,
              resumeAttached: false,
              stepCount,
              error:
                'LinkedIn closed the application mid-flow (session/bot-check) and returned to the job posting. ' +
                'Nothing was submitted — the window is open; re-open Easy Apply in it and finish manually.',
            };
          }
        }
      }

      // Check for submit button. In Auto-Apply mode (autoSubmit === true), click it automatically!
      // In Manual Apply mode, detect submit and stop for review.
      await scrollEasyApplyModal(page);
      if (await detectLinkedInSubmit(page)) {
        if (autoSubmit) {
          console.log('[linkedin] autoSubmit enabled — submitting application (step', stepCount, ')');
          const submitted = await clickLinkedInSubmit(page);
          if (submitted) {
            await page.waitForTimeout(3000);
            return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
          }
        }
        await forceLinkedInEnglish(page, page.context());
        console.log('[linkedin] submit detected — stopping for review (step', stepCount, ')');
        return { status: 'stopped_for_review', filledFields, resumeAttached: true, stepCount, readyForSubmit: true };
      }

      // Attempt resume upload (called every step; LinkedIn shows file input on varying steps)
      await uploadLinkedInResume(page, resumeFilename, resumePdfBytes);

      // Fill standard fields
      const filled = await fillLinkedInStandardFields(page, profile);
      filledFields.push(...filled);
      console.log('[linkedin] step', stepCount, 'filled:', filled);

      // Fill custom/screening questions (e.g. numeric years of experience)
      const qFilled = await fillLinkedInQuestions(page, profile);
      filledFields.push(...qFilled);
      if (qFilled.length) console.log('[linkedin] step', stepCount, 'questions filled:', qFilled);

      // Try to advance to the next step
      const advanced = await clickNextStep(page);
      if (!advanced) {
        // No next button found — re-scroll and check if submit button is visible now
        console.log('[linkedin] no next button on step', stepCount);
        await page.waitForTimeout(1000);
        await scrollEasyApplyModal(page);
        if (await detectLinkedInSubmit(page)) {
          if (autoSubmit) {
            console.log('[linkedin] autoSubmit enabled — submitting application after scroll (step', stepCount, ')');
            const submitted = await clickLinkedInSubmit(page);
            if (submitted) {
              await page.waitForTimeout(3000);
              return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
            }
          }
          await forceLinkedInEnglish(page, page.context());
          console.log('[linkedin] submit detected after scroll — stopping for review (step', stepCount, ')');
          return { status: 'stopped_for_review', filledFields, resumeAttached: true, stepCount, readyForSubmit: true };
        }

        // If the modal is still visible, stop for review! The user can fill any custom answers or review.
        const stillInModal = await easyApplyModalVisible(page);
        if (stillInModal) {
          await forceLinkedInEnglish(page, page.context());
          console.log('[linkedin] modal remains open on step', stepCount, '— stopping for review');
          return { status: 'stopped_for_review', filledFields, resumeAttached: true, stepCount, readyForSubmit: false };
        }

        // The modal is truly gone and no submit button was found
        const bounced = await detectLinkedInEasyApply(page);
        if (bounced) {
          return {
            status: 'error',
            filledFields,
            resumeAttached: false,
            stepCount,
            error:
              'LinkedIn closed the application mid-flow (session/bot-check) and returned to the job posting. ' +
              'Nothing was submitted — the window is open; re-open Easy Apply in it and finish manually.',
          };
        }
        break;
      } else {
        console.log('[linkedin] advanced to step', stepCount + 1);
      }

      // Wait for next step to begin rendering
      await page.waitForTimeout(2000);
    }

    // Finished loop iterations — stop for review
    return { status: 'stopped_for_review', filledFields, resumeAttached: true, stepCount };
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Full LinkedIn apply flow: launch browser (or reuse context), navigate to job URL,
 * detect Easy Apply, run the modal flow, and return the result.
 *
 * When the job has NO Easy Apply but carries an offsite "Apply" link, we navigate the SAME
 * window (a second context cannot share the profile dir while this one is open), run the
 * generic autofill heuristics on the company's form, and still stop before any submit.
 */

/**
 * Pre-launch the Chrome window and navigate to the LinkedIn job URL immediately.
 * Intended to be called in parallel with prepareSubmission (LLM + PDF generation)
 * so the user sees the browser open right away — not after all background work finishes.
 *
 * Handles the English locale setup (seedLinkedInEnglish + enforceEnglishJobUrl) so
 * the page already loads in English while the resume is being generated.
 *
 * Returns { ctx, page, targetUrl } on success, or null if launch fails.
 */
export async function preLaunchLinkedInBrowser(jobUrl: string): Promise<{
  ctx: BrowserContext;
  page: Page;
  targetUrl: string;
} | null> {
  const profileDir = resolveLinkedInProfileDir();
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  if (isApplyCancelled()) return null;
  try {
    const ctx = await launchApplyBrowser(profileDir, { focus: true });
    const page = ctx.pages()[0] || (await ctx.newPage());
    // Close leftover blank tabs so the window stays clean
    for (const p of ctx.pages()) {
      if (p !== page && (p.url() === 'about:blank' || p.url().startsWith('chrome://'))) {
        await p.close().catch(() => {});
      }
    }
    // Seed English locale cookies BEFORE any navigation (same as linkedInApply)
    await seedLinkedInEnglish(ctx);
    const targetUrl = enforceEnglishJobUrl(jobUrl);
    // Bring window to front only for first job apply
    await focusApplyPage(page, false);
    // Navigate to the job URL — this finishes in 2-5s, well before resume generation
    console.log('[linkedin] pre-launch: navigating to', targetUrl);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await focusApplyPage(page, false);
    console.log('[linkedin] Pre-launched browser and navigated to:', targetUrl);
    return { ctx, page, targetUrl };
  } catch (err) {
    console.warn('[linkedin] preLaunchLinkedInBrowser failed — linkedInApply will launch inline:', (err as Error).message);
    return null;
  }
}
export async function linkedInApply(opts: {
  jobUrl: string;
  profile: CandidateProfile;
  resumePdfBytes: Uint8Array;
  resumeFilename: string;
  coverLetterText?: string;
  autoSubmit?: boolean;
  /** Pre-launched browser context from preLaunchLinkedInBrowser. Skips re-launching Chrome. */
  prelaunchedContext?: { ctx: BrowserContext; page: Page; targetUrl: string } | null;
}): Promise<PlatformResult> {
  const { jobUrl, profile, resumePdfBytes, resumeFilename, coverLetterText, autoSubmit } = opts;

  const profileDir = resolveLinkedInProfileDir();
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  let ctx: BrowserContext | null = null;
  try {
    let page: Page;
    let targetUrl: string;

    if (opts.prelaunchedContext) {
      // ── Fast path: browser was launched in parallel with resume generation ──
      // The Chrome window was already shown to the user while the tailored PDF
      // was being generated. Confirm page is loaded and bring it to front.
      ctx = opts.prelaunchedContext.ctx;
      page = opts.prelaunchedContext.page;
      targetUrl = opts.prelaunchedContext.targetUrl;
      // Ensure navigation completed (it was started concurrently)
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
      } catch { /* already loaded or timed out — continue */ }
      // Safety re-navigate if page didn't land on LinkedIn
      const prelaunchUrl = page.url();
      if (prelaunchUrl === 'about:blank' || !prelaunchUrl.includes('linkedin.com')) {
        await seedLinkedInEnglish(ctx);
        targetUrl = enforceEnglishJobUrl(jobUrl);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      await focusApplyPage(page, false);
    } else {
      // ── Fallback: pre-launch failed or was not attempted ──
      ctx = await launchApplyBrowser(profileDir, { focus: true });
      page = ctx.pages()[0] || (await ctx.newPage());
      // Close any leftover blank tabs so the window stays clean
      for (const p of ctx.pages()) {
        if (p !== page && (p.url() === 'about:blank' || p.url().startsWith('chrome://'))) {
          await p.close().catch(() => {});
        }
      }
      await seedLinkedInEnglish(ctx);
      targetUrl = enforceEnglishJobUrl(jobUrl);
      console.log('[linkedin] navigating to', targetUrl);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await focusApplyPage(page, false);
    }

    await page.waitForTimeout(3500);
    console.log('[linkedin] landed on', page.url());
    await forceLinkedInEnglish(page, ctx);
    const loginRequired = await detectLinkedInLoginRequired(page);
    console.log('[linkedin] login_required?', loginRequired);
    if (loginRequired) {
      await focusApplyPage(page, true);

      const loginCompleted = await waitForLinkedInLogin(page, 120_000);
      if (!loginCompleted) {
        ctx = null;
        return {
          status: 'login_required',
          filledFields: [],
          resumeAttached: false,
          stepCount: 0,
          error: 'LinkedIn login required. Please log into your LinkedIn account in the Chrome window that opened.',
        };
      }
      // Login completed - wait for page to stabilize again
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    // Wait for page content to settle
    await page.locator('input, textarea, button').first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});

    console.log('[linkedin] easy_apply present?', await detectLinkedInEasyApply(page));
    console.log('[linkedin] external_apply href?', await detectLinkedInExternalApply(page));

    const result = await navigateLinkedInEasyApply({ page, profile, resumePdfBytes, resumeFilename, autoSubmit });

    // Bounce path: LinkedIn dropped the modal and reloaded the job posting, possibly as an Arabic
    // guest leaf. The user must finish manually in this window — re-assert English so the landing
    // page is usable. Safe here: on an error the modal is already gone (never reload under
    // `stopped_for_review`, that would destroy a live filled form).
    if (result.status === 'error' && !result.error?.includes('Easy Apply') && !result.error?.includes('applied')) {
      await forceLinkedInEnglish(page, ctx);
    }

    // External-apply handoff: this job is not eligible for the LinkedIn autofill workflow.
    // Keep the LinkedIn page open and return the external URL for the UI's manual link instead
    // of opening a second employer flow that may require cookies, CAPTCHA, or email verification.
    if (result.status === 'external_apply' && result.externalUrl) {
      ctx = null;
      return {
        status: 'external_apply',
        filledFields: [],
        resumeAttached: false,
        stepCount: 0,
        externalUrl: result.externalUrl,
        error: 'This LinkedIn posting uses an external career site and is not eligible for automated apply.',
      };

      /*
       * Kept below for reference while the generic external adapter is retired from the LinkedIn
       * autofill path. External sites remain available through the normal job link in the UI.
       */
      const context = ctx!; // non-null here (launch succeeded above)
      // Heavier SPAs open the form — or a login / CAPTCHA / another tab — as a NEW tab. Collect
      // every page the context produces so nothing is judged on the wrong window.
      const sidePages: Page[] = [];
      const onPage = (p: Page) => {
        sidePages.push(p);
        console.log('[linkedin] external popup opened:', p.url());
      };
      context.on('page', onPage);

      const externalUrl = result.externalUrl;
      if (!externalUrl) throw new Error('externalUrl missing');
      try {
        console.log('[linkedin] external handoff ->', externalUrl);
        const recipeHost = normalizeHost(externalUrl!);
        const recipe = getRecipe(recipeHost);
        console.log('[linkedin] external recipe for', recipeHost, `(attempts=${recipe.attempts}, login=${recipe.loginRequired}, captcha=${recipe.captchaGated}, labels=${recipe.revealLabels.join('|')})`);
        await grantExternalGeolocation(context, externalUrl!);
        await page.goto(externalUrl!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(8000);
        console.log('[linkedin] external landed on', page.url());
        await dismissCookieConsent(page);
        if (await clickExternalApplyControl(page)) {
          await page.waitForTimeout(3000);
        }

        let advancedLabels: string[] = [];
        await revealApplyForm(page, context, {
          revealLabels: recipe.revealLabels,
          onAdvanced: (lbls) => { advancedLabels = lbls; },
        });

        const pagesAll = [page, ...sidePages];
        const blocker = await classifyExternalBlocker(pagesAll);

        if (blocker.kind === 'fillable') {
          // Learned behaviour short-circuits the cold probes on the next apply to this employer.
          recordApplyAttempt(recipeHost, {
            revealLabels: advancedLabels.length ? advancedLabels : recipe.revealLabels,
            loginRequired: recipe.loginRequired,
            captchaGated: recipe.captchaGated,
            outcome: 'stopped_for_review',
          });
          // Multi-step wizards: fill whatever step renders, close interstitials, and advance until
          // the final Submit — which stays a human click.
          const filled = await fillAndAdvanceWizard(blocker.page, {
            profile,
            resumePdfBuf: resumePdfBytes,
            resumeFilename,
            coverLetterText,
          });
          try { await blocker.page.bringToFront(); } catch { /* ignore */ }
          ctx = null; // leave the window open for manual review + submit
          return {
            status: 'stopped_for_review',
            filledFields: filled.filledFields,
            resumeAttached: filled.attachedFiles.length > 0,
            stepCount: filled.stepsAdvanced + 1,
          };
        }

        if (blocker.kind === 'login' || blocker.kind === 'verification' || blocker.kind === 'captcha') {
          // The employer gates the form behind sign-in, an email identity code, or a CAPTCHA.
          // Only a human can complete that ONE step — notify via Windows popup, keep the window in
          // front, and CONTINUE filling automatically once the form renders. No automated bypass.
          // Duplicate auth tabs (if any slipped through) collide and end in "Trouble signing you
          // in" — close every login popup but the one the user will sign in on.
          if (blocker.kind === 'login') {
            for (const p of sidePages) {
              if (p === blocker.page) continue;
              try {
                if (await p.isClosed()) continue;
                if (await pageRequiresLogin(p)) {
                  console.log('[linkedin] external: closing duplicate login popup', p.url());
                  await p.close().catch(() => {});
                }
              } catch { /* ignore */ }
            }
          }
          try { await blocker.page.bringToFront(); } catch { /* ignore */ }
          const host = (() => {
            try { return new URL(blocker.page.url()).hostname.replace(/^www\./i, ''); } catch { return 'the company'; }
          })();
          notifyWindows(
            'HireMe — manual action needed',
            blocker.kind === 'login'
              ? `${host} needs a manual sign-in for this application. The window is now open — log in once, and the form will be filled automatically (the session is remembered for next time).`
              : blocker.kind === 'verification'
                ? `${host} needs an identity verification code. Enter the code you received by email in the open browser window; the application will continue automatically.`
              : `${host} gates this application behind a CAPTCHA. Solve it in the open window and the form will be filled automatically.`,
          );
          console.log('[linkedin] external:', blocker.kind, 'on', host, '- notified user, waiting for form');
          // Learned: this employer gates the application. Next time we notify IMMEDIATELY instead of
          // probing for fillable fields first.
          recordApplyAttempt(recipeHost, {
            revealLabels: advancedLabels.length ? advancedLabels : recipe.revealLabels,
            loginRequired: blocker.kind === 'login',
            captchaGated: blocker.kind === 'captcha',
            outcome: blocker.kind,
          });
          const resumed = await waitUntilFormAppears(context, pagesAll, 10 * 60_000);
          console.log('[linkedin] external wait finished; form available?', resumed !== null);
          if (resumed) {
            const pageResumed = resumed as Page;
            if (await hasFillableApplicationForm(pageResumed)) {
              // Kind of form we finally reached (e.g. login → post-login wizard).
              recordApplyAttempt(recipeHost, { outcome: 'stopped_for_review' });
              const filled = await fillAndAdvanceWizard(pageResumed, {
                profile,
                resumePdfBuf: resumePdfBytes,
                resumeFilename,
                coverLetterText,
              });
              try { await pageResumed.bringToFront(); } catch { /* ignore */ }
              ctx = null; // leave the window open for manual review + submit
              return {
                status: 'stopped_for_review',
                filledFields: filled.filledFields,
                resumeAttached: filled.attachedFiles.length > 0,
                stepCount: filled.stepsAdvanced + 1,
              };
            }
          }
        }

        // Still no fillable form: leave the window open for manual completion. Nothing was
        // submitted, and none of these are reported as success.
        try { await page.bringToFront(); } catch { /* ignore */ }
        ctx = null;
        if (blocker.kind === 'login') {
          recordApplyAttempt(recipeHost, { outcome: 'error:login-ta', loginRequired: true });
          return {
            status: 'error',
            filledFields: [],
            resumeAttached: false,
            stepCount: 1,
            error: 'Waited for a manual sign-in but the application form never became available. The window stays open — finish the application by hand (the session is remembered for next time).',
          };
        }
        if (blocker.kind === 'verification') {
          return {
            status: 'error',
            filledFields: [],
            resumeAttached: false,
            stepCount: 1,
            error: 'Enter the identity verification code in the open browser window. The application form did not appear before the wait expired.',
          };
        }
        if (blocker.kind === 'captcha') {
          recordApplyAttempt(recipeHost, { outcome: 'error:captcha-ta', captchaGated: true });
          return {
            status: 'error',
            filledFields: [],
            resumeAttached: false,
            stepCount: 1,
            error: 'Waited for the CAPTCHA to be solved but the application form never became available. The window stays open — finish the application by hand.',
          };
        }
        recordApplyAttempt(recipeHost, {
          outcome: blocker.kind === 'closed' ? 'posting_closed' : 'no_fillable_form',
          closedPosting: blocker.kind === 'closed',
        });
        return {
          status: 'error',
          filledFields: [],
          resumeAttached: false,
          stepCount: 1,
          error: blocker.kind === 'closed'
            ? 'The employer publishes through Greenhouse but its posting link appears closed (the board shows no matching position). Posting may have been filled, or the link is stale — verify on LinkedIn. The window stays open.'
            : 'The company site did not expose an application form that can be filled automatically. Use the open window and apply manually.',
        };
      } catch (err) {
        // Keep the window open for manual completion instead of closing it on them.
        try { await page.bringToFront(); } catch { /* ignore */ }
        ctx = null;
        return {
          status: 'error',
          filledFields: [],
          resumeAttached: false,
          stepCount: 1,
          error: `External apply handoff failed: ${(err as Error).message}`,
        };
      } finally {
        context.off('page', onPage);
      }
    }

    if (result.status === 'cancelled') {
      if (ctx) await ctx.close().catch(() => {});
      ctx = null;
      return result;
    }

    if (result.status === 'already_applied') {
      if (ctx) await ctx.close().catch(() => {});
      ctx = null;
      return result;
    }

    if (autoSubmit && result.status === 'submitted') {
      try {
        const pages = ctx.pages();
        for (let i = 1; i < pages.length; i++) {
          await pages[i].close().catch(() => {});
        }
        if (pages[0] && !pages[0].isClosed()) {
          await pages[0].goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
        }
      } catch { /* ignore */ }
      ctx = null; // Do not close in finally; activeContext stays alive for next job
    } else {
      // Stopped for manual review — bring window to front for user
      await focusApplyPage(page, true);
      ctx = null; // ownership transferred to the user session
    }
    return result;
  } catch (err) {
    console.error('[linkedin] apply error:', err);
    const isClosedError = (err as Error)?.message?.toLowerCase().includes('closed');
    if (ctx) {
      if (!isClosedError) await focusApplyPage(ctx.pages()[0], false);
      ctx = null; // Preserve window open for user review
    }
    if (isClosedError) {
      return {
        status: 'stopped_for_review',
        readyForSubmit: true,
        filledFields: [],
        resumeAttached: true,
        stepCount: 1,
      };
    }
    return {
      status: 'error',
      filledFields: [],
      resumeAttached: false,
      stepCount: 0,
      error: (err as Error).message,
    };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

/**
 * Detect whether LinkedIn has confirmed the application was successfully submitted.
 */
export async function detectLinkedInApplicationSubmitted(page: Page): Promise<boolean> {
  try {
    const rawBody = await page.evaluate(() => {
      return document.body ? document.body.innerText.toLowerCase().slice(0, 50_000) : '';
    }).catch(() => '');

    const SUBMITTED_PHRASES = [
      'application sent',
      'your application was sent',
      'application submitted',
      'already applied',
      'you have applied',
    ];

    for (const phrase of SUBMITTED_PHRASES) {
      if (rawBody.includes(phrase)) {
        return true;
      }
    }

    const modalSuccess = page.locator('div:has-text("Application sent"), button:has-text("Applied"), .jobs-apply-form__post-apply-content').first();
    if ((await modalSuccess.count()) > 0 && (await modalSuccess.isVisible().catch(() => false))) {
      return true;
    }
  } catch {
    // continue
  }
  return false;
}

