// Naukri Easy Apply / chatbot adapter — opens the Naukri job page, detects
// whether it supports direct apply, handles Naukri's chatbot-style multi-step
// question flow, fills questions for which we have prepared answers, uploads
// the tailored resume PDF, and STOPS when the application is ready for review.
//
// Selector knowledge adapted from github.com/pulkit017/job-apply-mcp (unlicensed;
// factual DOM selectors, not copyrightable expression). All code is original TypeScript.
//
// Naukri applies use a chatbot interface (not a standard form). The bot asks
// questions one at a time via li.botItem elements, and the candidate responds
// via radio buttons or contenteditable text inputs.

import { type BrowserContext, type Page, type Locator } from 'playwright';
import path from 'path';
import fs from 'fs';
import type { CandidateProfile, PlatformResult } from './platform';
import { launchApplyBrowser, bringWindowToFront, focusApplyPage, shouldBringWindowToFront, AUTO_APPLY_SUCCESS_PAGE, isApplyCancelled, getSystemChromeProfileDir } from './launcher';
import { getApplyConfig, answerScreeningQuestion, normalizeCityName, matchCityResidenceQuestion } from './questions';
import { resolveScreeningQuestionWithGemini, type FieldConstraints } from './llm-screening';

export { normalizeCityName, matchCityResidenceQuestion };

const BROWSER_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

/**
 * Resolve the best Chrome profile directory for Naukri: prefer the user's REAL Chrome profile
 * so DPAPI-encrypted session cookies are decryptable → Naukri opens already signed in.
 * Falls back to the isolated Playwright profile when Chrome isn't installed or the profile
 * can't be found (or when the user's everyday Chrome is already open on that profile).
 */
function resolveNaukriProfileDir(): string {
  return BROWSER_PROFILE_DIR;
}

// ----- Naukri-specific selectors ---------------------------------------------

export const DIRECT_APPLY_BUTTON_SELECTORS = [
  'button#apply-button',
  'button.apply-button',
  'button:has-text("Apply Now")',
  'button:has-text("Direct Apply")',
  'button:has-text("Apply")',
  'a:has-text("Apply Now")',
  'a:has-text("Direct Apply")',
  'a#apply-button',
  'a.apply-button',
  '#apply-button',
  '.apply-button',
  '.applyBtn',
  '[class*="apply-button"]',
  '[class*="applyBtn"]',
];

const APPLY_BUTTON_SELECTORS = DIRECT_APPLY_BUTTON_SELECTORS;

const COMPANY_SITE_SELECTORS = [
  'button#company-site-button',
  'a#company-site-button',
  'button:has-text("Apply on company site")',
  'a:has-text("Apply on company site")',
  'button:has-text("Company Site")',
  'a:has-text("Company Site")',
  'button:has-text("Apply on Company Website")',
  'a:has-text("Apply on Company Website")',
  'button:has-text("Apply on Company Site")',
  'a:has-text("Apply on Company Site")',
  'button:has-text("Apply via Company")',
  'a:has-text("Apply via Company")',
  // Class-based selectors for Naukri DOM variants
  '[class*="company-site"]',
  '[class*="companySite"]',
  '[class*="external-apply"]',
  '[class*="externalApply"]',
  '[data-ga-track*="company"]',
  '[aria-label*="company site" i]',
  '[aria-label*="company website" i]',
];

const CHATBOT_DRAWER = ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot" i], div[class*="drawer" i], div[class*="Drawer"], div[class*="apply-container" i], div[class*="applyDrawer" i], div[class*="tuple-drawer" i], div[class*="chat-container" i], section[class*="chatbot" i], aside[class*="chatbot" i], div.apply-layer)';

const CHATBOT_MESSAGE = 'li.botItem, li[class*="botItem"], div.botItem, div[class*="botItem"], div.msg_container.bot, div.botMsg, [class*="bot-msg" i], [class*="botMessage" i]';

const CHATBOT_TEXT_INPUT = [
  `${CHATBOT_DRAWER} div[contenteditable="true"].textArea`,
  `${CHATBOT_DRAWER} div.textAreaWrapper [contenteditable="true"]`,
  `${CHATBOT_DRAWER} div[contenteditable="true"]`,
  `${CHATBOT_DRAWER} input[type="text"].chatbot_Input`,
  `${CHATBOT_DRAWER} input.chatbot_Input`,
  `${CHATBOT_DRAWER} input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])`,
  `${CHATBOT_DRAWER} textarea`,
  'div.chatbot_DrawerContentWrapper div[contenteditable="true"]',
  'div.chatbot_DrawerContentWrapper input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])',
  'div.chatbot_DrawerContentWrapper textarea',
].join(', ');

const CHATBOT_SKILL_CHIPS = [
  `${CHATBOT_DRAWER} div.suggested-chips div.chip`,
  `${CHATBOT_DRAWER} div.suggested-chips span`,
  `${CHATBOT_DRAWER} .chip-item`,
  `${CHATBOT_DRAWER} .ssrc__chip`,
  `${CHATBOT_DRAWER} .skill-chip`,
  `${CHATBOT_DRAWER} [class*="chip"]`,
  `${CHATBOT_DRAWER} [class*="tag"]`,
  `${CHATBOT_DRAWER} [class*="suggested-skill"]`,
].join(', ');

const CHATBOT_CUSTOM_DROPDOWN = [
  `${CHATBOT_DRAWER} div[class*="dropdown"]`,
  `${CHATBOT_DRAWER} div[class*="select"]`,
  `${CHATBOT_DRAWER} div[class*="custom-select"]`,
  `${CHATBOT_DRAWER} div.droppable`,
  `${CHATBOT_DRAWER} input[placeholder*="location" i]`,
  `${CHATBOT_DRAWER} input[placeholder*="city" i]`,
  `${CHATBOT_DRAWER} input[placeholder*="search" i]`,
  `${CHATBOT_DRAWER} input[placeholder*="select" i]`,
].join(', ');

const CHATBOT_SKIP_BUTTON = [
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) button:has-text("Skip this question")',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) div:has-text("Skip this question")',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) span:has-text("Skip this question")',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) a:has-text("Skip this question")',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) .skip-btn',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) [class*="skipBtn"]',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) button:has-text("Skip")',
  'button:has-text("Skip this question")',
  'div:has-text("Skip this question")',
  'span:has-text("Skip this question")',
  'a:has-text("Skip this question")',
  '.skip-btn',
  '[class*="skipBtn"]',
  'button:has-text("Skip")',
].join(', ');

const CHATBOT_RADIO = [
  `${CHATBOT_DRAWER} input[type="radio"]`,
  `${CHATBOT_DRAWER} [role="radio"]`,
  `${CHATBOT_DRAWER} label.ssrc__label`,
  `${CHATBOT_DRAWER} .ssrc__radio-btn-container`,
  `${CHATBOT_DRAWER} .singleselect-radiobutton`,
  `${CHATBOT_DRAWER} label[class*="radio" i]`,
  `${CHATBOT_DRAWER} div[class*="radio" i]`,
  `${CHATBOT_DRAWER} div[class*="singleselect" i]`,
  `${CHATBOT_DRAWER} [class*="radio-item" i]`,
  `${CHATBOT_DRAWER} [class*="radioBtn" i]`,
  `${CHATBOT_DRAWER} [class*="radio-btn" i]`,
  'input[type="radio"]',
  '[role="radio"]',
  'label.ssrc__label',
  '.ssrc__radio-btn-container',
  '.singleselect-radiobutton',
  'label[class*="radio" i]',
  'div[class*="radio" i]',
  'div[class*="singleselect" i]',
].join(', ');

const CHATBOT_CHECKBOX = `${CHATBOT_DRAWER} div.multiselectcheckboxes, ${CHATBOT_DRAWER} .mcc__checkbox, ${CHATBOT_DRAWER} label.mcc__label, div.multiselectcheckboxes, .mcc__checkbox, label.mcc__label`;

const CHATBOT_FILE_UPLOAD = `${CHATBOT_DRAWER} input.chatbot_Uploader[type="file"], ${CHATBOT_DRAWER} input[type="file"][class*="chatbot"], input.chatbot_Uploader[type="file"]`;

const CHATBOT_SAVE_BUTTON = [
  `${CHATBOT_DRAWER} div.send:not(.disabled) div.sendMsg`,
  `${CHATBOT_DRAWER} div.send:not(.disabled)`,
  `${CHATBOT_DRAWER} button:has-text("Save"):not([disabled])`,
  `${CHATBOT_DRAWER} button:has-text("Next"):not([disabled])`,
  'div.send:not(.disabled) div.sendMsg',
  'div.send:not(.disabled)',
  'button:has-text("Save"):not([disabled])',
  'button:has-text("Next"):not([disabled])',
  `${CHATBOT_DRAWER} button:has-text("Save")`,
  'button:has-text("Save")',
  'div.sendMsg',
].join(', ');

export const CHATBOT_CLOSE_BUTTON = [
  `${CHATBOT_DRAWER} .crossIcon`,
  `${CHATBOT_DRAWER} [class*="crossIcon"]`,
  `${CHATBOT_DRAWER} [class*="cross_icon"]`,
  `${CHATBOT_DRAWER} [class*="cross-icon"]`,
  `${CHATBOT_DRAWER} [class*="closeIcon"]`,
  `${CHATBOT_DRAWER} [class*="close_icon"]`,
  `${CHATBOT_DRAWER} [class*="close-icon"]`,
  `${CHATBOT_DRAWER} .chatbot_DrawerClose`,
  `${CHATBOT_DRAWER} [class*="DrawerClose"]`,
  `${CHATBOT_DRAWER} [class*="drawerClose"]`,
  `${CHATBOT_DRAWER} [class*="header"] [class*="cross"]`,
  `${CHATBOT_DRAWER} [class*="header"] [class*="close"]`,
  `${CHATBOT_DRAWER} button[aria-label*="close" i]`,
  `${CHATBOT_DRAWER} svg[class*="cross"]`,
  `${CHATBOT_DRAWER} svg[class*="close"]`,
  `${CHATBOT_DRAWER} i[class*="cross"]`,
  `${CHATBOT_DRAWER} i[class*="close"]`,
  // Standalone / top-level drawer close elements
  '.crossIcon',
  '[class*="crossIcon"]',
  '[class*="cross_icon"]',
  '[class*="cross-icon"]',
  '.chatbot_DrawerClose',
  '[class*="DrawerClose"]',
  '[class*="drawerClose"]',
  '[class*="chatbot"] [class*="cross"]',
  '[class*="chatbot"] [class*="close"]',
  '[class*="drawer"] [class*="cross"]',
  '[class*="drawer"] [class*="close"]',
  'div[class*="drawer"] button[class*="close"]',
  'button[aria-label*="close" i]',
].join(', ');

const CAPTCHA_TEXT_PATTERNS = /captcha|recaptcha|hcaptcha|verify you are human|security check|are you a robot/i;

// ----- Detection -------------------------------------------------------------

/**
 * Automatically dismiss / close the Naukri chatbot side pop-up drawer.
 * Attempts close button click, and falls back to pressing Escape.
 */
export async function closeNaukriChatbotDrawer(page: Page): Promise<boolean> {
  try {
    const closeBtn = page.locator(CHATBOT_CLOSE_BUTTON).first();
    if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible().catch(() => false))) {
      console.log('[naukri] Closing chatbot drawer via close button');
      await closeBtn.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(600);
      return true;
    }
  } catch {
    // continue
  }

  // Fallback: pressing Escape closes pop-up drawers on Naukri
  try {
    if (page.keyboard) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      return true;
    }
  } catch {
    // continue
  }
  return false;
}

/**
 * Detect whether Naukri has confirmed the application was successfully submitted.
 */
export async function detectNaukriApplicationSubmitted(page: Page): Promise<boolean> {
  try {
    // 0. Check URL navigation (Naukri redirects to /myapply/saveApply on successful submission)
    const currentUrl = page.url ? page.url() : '';
    if (currentUrl.includes('/myapply/saveApply') || currentUrl.includes('multiApplyResp')) {
      return true;
    }

    // 1. Text checks across document body (full text without premature slicing)
    const rawBody = await page.evaluate(() => {
      return document.body ? document.body.innerText.toLowerCase().slice(0, 100_000) : '';
    }).catch(() => '');
    const bodyText = (typeof rawBody === 'string' ? rawBody : '').toLowerCase();

    const SUBMITTED_PHRASES = [
      'applied successfully',
      'successfully applied',
      'application submitted',
      'application sent',
      'your application has been sent',
      'you have successfully applied',
      'already applied',
      'you have already applied',
      'application received',
      'thank you for your responses',
      'thank you for applying',
      'responses have been recorded',
    ];

    for (const phrase of SUBMITTED_PHRASES) {
      if (bodyText.includes(phrase)) {
        return true;
      }
    }

    // 2. Status on main Apply button or success badges
    const successLocators = [
      'button:has-text("Applied")',
      'a:has-text("Applied")',
      'span:has-text("Applied")',
      '.apply-message',
      '.applied-msg',
      '.apply-success',
      '[class*="applied-success"]',
      '[class*="success-msg"]',
      '[class*="alreadyApplied"]',
      '[class*="already-applied"]',
      'div:has-text("Applied successfully")',
      'span:has-text("Applied successfully")',
      'p:has-text("Applied successfully")',
      '[class*="success"]:has-text("Applied")',
    ];

    for (const sel of successLocators) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          const text = (await el.innerText().catch(() => '')).trim();
          if (/^applied\b|applied successfully|application sent/i.test(text)) {
            return true;
          }
        }
      } catch {
        // continue
      }
    }
  } catch {
    // continue
  }
  return false;
}

/**
 * Wait for Naukri submission confirmation to appear, polling periodically.
 */
export async function waitForNaukriSubmission(page: Page, maxWaitMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await detectNaukriApplicationSubmitted(page)) {
      return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

export const NAUKRI_EXPIRED_PATTERNS = [
  /this job is no longer available/i,
  /this job has expired/i,
  /job has expired/i,
  /job is expired/i,
  /applications are closed for this job/i,
  /no longer accepting applications/i,
  /this vacancy has expired/i,
  /this vacancy is no longer available/i,
  /the job you are looking for is no longer available/i,
  /this job is currently inactive/i,
  /listing has expired/i,
  /listing is expired/i,
  /posting has expired/i,
  /position has been closed/i,
  /position is closed/i,
  /applications closed/i,
  /applications are closed/i,
  /vacancy closed/i,
  /job closed/i,
  /expired job/i,
];

/**
 * Detect whether the Naukri job posting has expired or closed.
 * Checks both explicit badges/elements and rendered body text.
 */
export async function detectNaukriExpired(page: Page): Promise<boolean> {
  try {
    // 1. Explicit badges, banners, buttons, or message tags
    const expiredBadges = [
      '[class*="job-expired" i]',
      '[class*="jobExpired" i]',
      '[class*="expired-banner" i]',
      '[class*="expired-msg" i]',
      '[class*="expired-tag" i]',
      '[class*="expired" i]',
      'button:has-text("Job Expired")',
      'button:has-text("Expired")',
      'button:text-is("Expired")',
      'span:text-is("Expired")',
      'div:text-is("Expired")',
      'span:has-text("Job has expired")',
      'div:has-text("Job has expired")',
      'p:has-text("Job has expired")',
      'div:has-text("This job is no longer available")',
      'p:has-text("This job is no longer available")',
      'div:has-text("No longer accepting applications")',
    ];

    for (const sel of expiredBadges) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          const text = (await el.innerText().catch(() => '')).trim().toLowerCase();
          if (
            text.includes('expired') ||
            text.includes('no longer available') ||
            text.includes('closed') ||
            text.includes('no longer accepting')
          ) {
            return true;
          }
        }
      } catch {}
    }

    // 2. Scan page body / main container text
    const bodySnippet = await page.evaluate(() => {
      const el = document.querySelector('.job-desc, .leftSec, main, #root, #app') || document.body;
      return (el as HTMLElement)?.innerText?.slice(0, 10000) || '';
    }).catch(() => '');

    if (bodySnippet) {
      for (const pattern of NAUKRI_EXPIRED_PATTERNS) {
        if (pattern.test(bodySnippet)) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}

/**
 * Detect whether the Naukri job page only supports external application (Apply on company site).
 * Checks explicit selectors as well as DOM elements for external phrasing.
 */
export async function detectNaukriCompanySite(page: Page): Promise<boolean> {
  // 1. Check explicit company site selectors
  for (const sel of COMPANY_SITE_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        return true;
      }
    } catch {}
  }

  // 2. Inspect buttons and links for external apply text
  try {
    const isCompany = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], .apply-button, [class*="apply"]'));
      for (const el of candidates) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (
          text.includes('apply on company') ||
          text.includes('company site') ||
          text.includes('company website') ||
          text.includes('apply via company') ||
          text.includes('apply externally') ||
          text.includes('visit company') ||
          text.includes('apply now on company')
        ) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
            return true;
          }
        }
      }
      return false;
    });
    if (isCompany) return true;
  } catch {}

  return false;
}

/**
 * Find the direct Apply (Easy Apply) button on the Naukri job page.
 * Returns null if the page is expired, requires external apply, or has no direct button.
 */
export async function findNaukriDirectApplyButton(page: Page): Promise<Locator | null> {
  // Disqualify immediately if expired or company site
  if (await detectNaukriExpired(page)) return null;
  if (await detectNaukriCompanySite(page)) return null;

  for (const sel of DIRECT_APPLY_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        const text = (await btn.innerText().catch(() => '')).trim();
        // Negative checks
        if (/apply on company|company site|company website|apply via company|external|visit site/i.test(text)) {
          continue;
        }
        if (/already applied|expired|closed/i.test(text)) {
          continue;
        }
        if (/login to apply|sign in|continue with google/i.test(text)) {
          continue;
        }
        // Positive check
        if (/apply/i.test(text) || sel.includes('apply')) {
          return btn;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Detect whether Naukri's direct-apply (Easy Apply) button is present.
 * Returns false if the job is expired or company-site button is visible.
 */
export async function detectNaukriEasyApply(page: Page): Promise<boolean> {
  // 1. Check for explicit company site buttons (external apply only)
  for (const sel of COMPANY_SITE_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        return false;
      }
    } catch {}
  }

  // 2. Check for direct apply buttons
  for (const sel of DIRECT_APPLY_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        const text = (await btn.innerText().catch(() => '')).trim();
        if (/apply on company|company site|company website|apply via company|external|visit site|apply now on/i.test(text)) {
          return false;
        }
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Detect CAPTCHA on the current page.
 */
export async function detectNaukriCaptcha(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
    if (CAPTCHA_TEXT_PATTERNS.test(bodyText)) return true;
  } catch {
    // ignore
  }
  // Also check for recaptcha iframes
  try {
    if ((await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').first().count()) > 0) return true;
  } catch {
    // ignore
  }
  return false;
}

/**
 * Detect if login is required (login modal or redirect).
 */
export async function detectNaukriLoginRequired(page: Page): Promise<boolean> {
  // If application was ALREADY submitted or confirmed on Naukri, login is NOT required!
  if (await detectNaukriApplicationSubmitted(page).catch(() => false)) {
    return false;
  }

  // Check URL for login page patterns
  try {
    const url = page.url();
    if (
      url.includes('/login') ||
      url.includes('/signin') ||
      url.includes('/auth') ||
      url.includes('/nlogin') ||
      url.includes('login.naukri.com')
    ) {
      return true;
    }
  } catch {
    // ignore
  }

  // Naukri shows explicit login required buttons when not authenticated
  try {
    const loginBtn = page.locator(
      'button#login-apply-button, button#continue-with-google-button, [class*="continue-with-google"], .login-to-apply, button:has-text("Login to apply"), a:has-text("Login to apply")'
    ).first();
    if ((await loginBtn.count()) > 0 && (await loginBtn.isVisible().catch(() => false))) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Wait for the user to complete login on the Naukri login page.
 * Polls for login completion by checking if login buttons disappear and job content appears.
 */
export async function waitForNaukriLogin(
  page: Page,
  maxWaitMs = 120_000
): Promise<boolean> {
  const start = Date.now();
  console.log('[naukri] Waiting for user to complete login...');

  while (Date.now() - start < maxWaitMs) {
    // Check if login is no longer required
    const loginRequired = await detectNaukriLoginRequired(page);
    if (!loginRequired) {
      // Login appears complete - verify we're not on a login page
      const url = page.url();
      console.log(`[naukri] Login buttons gone, current URL: ${url}`);
      // Accept any non-login URL as success (Naukri may redirect to various pages after login)
      const isLoginPage = url.includes('/login') || url.includes('/signin') || url.includes('/auth') || url.includes('/nlogin') || url.includes('login.naukri.com');
      if (!isLoginPage) {
        console.log('[naukri] Login completed successfully');
        return true;
      }
      console.log('[naukri] Login buttons gone but still on login page, waiting...');
    }

    // Check for CAPTCHA
    if (await detectNaukriCaptcha(page)) {
      console.warn('[naukri] CAPTCHA detected during login wait');
      return false;
    }

    // Check if application was submitted (edge case)
    if (await detectNaukriApplicationSubmitted(page)) {
      console.log('[naukri] Application already submitted');
      return true;
    }

    // Log progress every 15 seconds
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (elapsed % 15 === 0 && elapsed > 0) {
      console.log(`[naukri] Still waiting for login... (${elapsed}s elapsed, URL: ${page.url()})`);
    }

    await page.waitForTimeout(3000);
  }

  console.warn('[naukri] Login wait timed out');
  return false;
}

// ----- Chatbot interaction ---------------------------------------------------

/**
 * Detect whether the chatbot drawer is open and has an active question.
 */
async function isChatbotOpen(page: Page): Promise<boolean> {
  try {
    // If application is already confirmed submitted, chatbot has completed
    if (await detectNaukriApplicationSubmitted(page)) return false;

    // Check if any chatbot drawer container or layer is visible
    const drawerSelectors = [
      CHATBOT_DRAWER,
      'div[class*="chatbot" i]',
      'div[class*="drawer" i]',
      'div[class*="apply-container" i]',
      'div[class*="applyDrawer" i]',
      'div[class*="tuple-drawer" i]',
      'div[class*="chat-container" i]',
      'section[class*="chatbot" i]',
      'aside[class*="chatbot" i]',
      'div.apply-layer',
    ];

    for (const sel of drawerSelectors) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        return true;
      }
    }

    // Check for bot message or interactive question elements directly
    const botMsg = page.locator('li.botItem, li[class*="botItem"], div.botItem, div[class*="botItem"], [class*="botMsg" i], [class*="bot_msg" i]').first();
    if ((await botMsg.count()) > 0 && (await botMsg.isVisible().catch(() => false))) {
      return true;
    }

    const textInput = page.locator(CHATBOT_TEXT_INPUT).first();
    if ((await textInput.count()) > 0 && (await textInput.isVisible().catch(() => false))) {
      return true;
    }

    const radio = page.locator(CHATBOT_RADIO).first();
    if ((await radio.count()) > 0 && (await radio.isVisible().catch(() => false))) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Read the latest bot message to understand the current question.
 */
async function getCurrentQuestionText(page: Page): Promise<string> {
  try {
    const messages = page.locator(CHATBOT_MESSAGE);
    const count = await messages.count();
    if (count === 0) return '';
    // Last bot message is the current question
    const last = messages.nth(count - 1);
    return (await last.innerText().catch(() => '')).trim();
  } catch {
    return '';
  }
}

/**
 * Classify the current question type.
 */
async function detectQuestionType(page: Page, questionText: string): Promise<'radio' | 'checkbox' | 'skill_chips' | 'custom_dropdown' | 'file_upload' | 'select' | 'text' | 'unknown'> {
  // 1. Radio buttons (single-select questions, Yes/No, experience ranges)
  const radio = page.locator(CHATBOT_RADIO).first();
  if ((await radio.count()) > 0 && (await radio.isVisible().catch(() => false))) {
    return 'radio';
  }

  // 2. Multi-select Checkboxes (preferred location, multiple skills)
  const checkbox = page.locator(CHATBOT_CHECKBOX).first();
  if ((await checkbox.count()) > 0 && (await checkbox.isVisible().catch(() => false))) {
    return 'checkbox';
  }

  // 3. Skill Chips / Tag Buttons
  if (/skills|keyskills|key skills/i.test(questionText) || ((await page.locator(CHATBOT_SKILL_CHIPS).first().count() > 0) && (await page.locator(CHATBOT_SKILL_CHIPS).first().isVisible().catch(() => false)))) {
    return 'skill_chips';
  }

  // 4. Native select
  const selects = page.locator(`${CHATBOT_DRAWER} select`).first();
  if ((await selects.count()) > 0 && (await selects.isVisible().catch(() => false))) {
    return 'select';
  }

  // 5. Custom Dropdown / Searchable location input
  if (/location|city|where do you live|reside|locality|area/i.test(questionText) && ((await page.locator(CHATBOT_CUSTOM_DROPDOWN).first().count() > 0) && (await page.locator(CHATBOT_CUSTOM_DROPDOWN).first().isVisible().catch(() => false)))) {
    return 'custom_dropdown';
  }

  // 6. File upload (only if question specifically prompts for resume/CV/upload)
  if (/resume|cv|upload|attach/i.test(questionText)) {
    const fileInput = page.locator(CHATBOT_FILE_UPLOAD).first();
    if ((await fileInput.count()) > 0) {
      return 'file_upload';
    }
  }

  // 7. Visible text input (contenteditable div or input)
  const textInput = page.locator(CHATBOT_TEXT_INPUT).first();
  if ((await textInput.count()) > 0 && (await textInput.isVisible().catch(() => false))) {
    return 'text';
  }

  return 'unknown';
}

/**
 * Read the available options for a radio button question.
 * Uses comprehensive DOM inspection (inputs, labels, containers, ARIA roles)
 * with robust whitespace and newline normalization.
 */
async function getRadioOptions(page: Page): Promise<string[]> {
  try {
    const options = await page.evaluate(() => {
      const drawer = document.querySelector(
        'div.chatbot_DrawerContentWrapper, div[class*="chatbot" i], div[class*="drawer" i], div[class*="applyDrawer" i], div[class*="apply-container" i]'
      ) || document.body;

      const items = Array.from(drawer.querySelectorAll(
        'input[type="radio"], [role="radio"], label.ssrc__label, .singleselect-radiobutton, .ssrc__radio-btn-container, label[class*="radio" i], div[class*="radio" i], div[class*="singleselect" i], [class*="radio-item" i]'
      ));

      const results: string[] = [];
      for (const el of items) {
        let text = '';
        if (el instanceof HTMLInputElement && el.type === 'radio') {
          if (el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) text = lbl.textContent || '';
          }
          if (!text) {
            const parentLbl = el.closest('label');
            if (parentLbl) text = parentLbl.textContent || '';
          }
          if (!text) {
            const sibLbl = el.nextElementSibling;
            if (sibLbl && /label|span/i.test(sibLbl.tagName)) text = sibLbl.textContent || '';
          }
          if (!text && el.value && el.value !== 'on') text = el.value;
          if (!text) text = el.getAttribute('aria-label') || '';
        } else {
          const childTextEl = el.querySelector('.ssrc__label, span, label, p');
          text = (childTextEl?.textContent || (el as HTMLElement).innerText || el.textContent || '');
        }

        const clean = text.replace(/\s+/g, ' ').replace(/\b(?:required|mandatory)\b/gi, '').trim();
        if (clean && clean.length > 0 && clean.length < 100 && !/skip this question|botItem|chatbot|drawer|step/i.test(clean)) {
          if (!results.some((r) => r.toLowerCase() === clean.toLowerCase())) {
            results.push(clean);
          }
        }
      }
      return results;
    }).catch(() => []);

    if (options && options.length > 0) return options;

    // Fallback locator
    const labels = page.locator(`${CHATBOT_DRAWER} label.ssrc__label, ${CHATBOT_DRAWER} label, ${CHATBOT_DRAWER} .singleselect-radiobutton, ${CHATBOT_DRAWER} input[type="radio"]`);
    const count = await labels.count();
    const fallbackOptions: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = (await labels.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text && text.length < 100 && !fallbackOptions.includes(text) && !/skip this question/i.test(text)) {
        fallbackOptions.push(text);
      }
    }
    return fallbackOptions;
  } catch {
    return [];
  }
}

function parseOptionYears(text: string): number {
  const lower = text.toLowerCase();
  if (/no experience|none|fresher|0/i.test(lower)) return 0;
  const rangeMatch = text.match(/(\d+)\s*[-–to]\s*(\d+)/i);
  if (rangeMatch) return (parseInt(rangeMatch[1], 10) + parseInt(rangeMatch[2], 10)) / 2;
  const gtMatch = text.match(/[>+]\s*(\d+)/);
  if (gtMatch) return parseInt(gtMatch[1], 10) + 1;
  const ltMatch = text.match(/[<]\s*(\d+)/);
  if (ltMatch) return Math.max(0, parseInt(ltMatch[1], 10) - 1);
  const num = parseInt(text.replace(/\D/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Match a candidate's numeric years of experience to the best radio option.
 * Prioritizes explicit range brackets (e.g. candidate with 3, 3.5, 4, 4.5, 5 yrs matches "3-5 years")
 * over strict upper bounds like "<3 years".
 */
export function matchExperienceOption(options: string[], candidateYears: number): number {
  // 1. Direct range match (e.g. "3-5 years" matches candidate with 3 to 5 years)
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const rangeMatch = opt.match(/(\d+)\s*[-–to]\s*(\d+)/i);
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1]);
      const max = parseFloat(rangeMatch[2]);
      if (candidateYears >= min && candidateYears <= max) {
        return i;
      }
    }
    const gtMatch = opt.match(/[>+]\s*(\d+)/);
    if (gtMatch) {
      const min = parseFloat(gtMatch[1]);
      if (candidateYears >= min) {
        return i;
      }
    }
    const ltMatch = opt.match(/[<]\s*(\d+)/);
    if (ltMatch) {
      const max = parseFloat(ltMatch[1]);
      if (candidateYears < max) {
        return i;
      }
    }
  }

  // 2. Fallback: closest midpoint
  const sorted = options.map((opt, idx) => ({
    text: opt,
    idx,
    diff: Math.abs(parseOptionYears(opt) - candidateYears),
  })).sort((a, b) => a.diff - b.diff);

  return sorted[0]?.idx ?? 0;
}

/**
 * Answer a radio button question by clicking the matching option.
 */
/**
 * Answer a radio button question by clicking the matching option.
 * Uses robust multi-tier selection (label click, radio check, ARIA role check,
 * and in-page JavaScript evaluation with trusted event dispatch).
 */
export async function answerRadioQuestion(
  page: Page,
  questionText: string,
  profile: CandidateProfile,
  options: string[],
): Promise<boolean> {
  let activeOptions = [...options];
  if (activeOptions.length === 0) {
    activeOptions = await getRadioOptions(page);
  }

  let targetIndex = -1;
  let targetAnswer: string | null = null;

  // 1. Ex-employee / previous employment with target company
  if (/ex[- ](employee|emp|infosys|tcs|wipro|cognizant|accenture|hcl|tech mahindra|capgemini)|former employee|previous employee|past employee|previously worked/i.test(questionText)) {
    targetAnswer = 'No';
    targetIndex = activeOptions.findIndex((o) => o.toLowerCase() === 'no');
    if (targetIndex < 0) {
      targetIndex = activeOptions.findIndex((o) => /na|none|never|false/i.test(o));
    }
  }

  // 2. City residence verification (e.g. "Are you residing curretly in Hydrabad ?")
  else if (matchCityResidenceQuestion(questionText, profile.location)) {
    const cityCheck = matchCityResidenceQuestion(questionText, profile.location)!;
    targetAnswer = cityCheck.answer;
    targetIndex = activeOptions.findIndex((o) => o.trim().toLowerCase() === cityCheck.answer.toLowerCase());
    if (targetIndex < 0 && activeOptions.length > 0) {
      // If options are city names, match target city or profile location
      const cityMatchIdx = activeOptions.findIndex((o) =>
        o.toLowerCase().includes(cityCheck.targetCity.toLowerCase()) ||
        (profile.location && o.toLowerCase().includes(profile.location.toLowerCase()))
      );
      if (cityMatchIdx >= 0) {
        targetIndex = cityMatchIdx;
        targetAnswer = activeOptions[cityMatchIdx];
      }
    }
  }

  // 3. Relocation / willing to relocate
  else if (/relocat/i.test(questionText)) {
    targetAnswer = 'Yes';
    targetIndex = activeOptions.findIndex((o) => /yes|true|agree|willing|sure/i.test(o));
    if (targetIndex < 0 && activeOptions.length > 0) {
      targetIndex = 0;
      targetAnswer = activeOptions[0];
    }
  }

  // 4. Work from office / hybrid / on-site / shifts / travel / walk-in / interview attendance
  else if (/work from office|wfo|hybrid|on[- ]?site|in[- ]?office|night shift|rotational|shifts|travel|business travel|attend|walk[- ]?in|drive|in[- ]?person|interview|venue|slot/i.test(questionText)) {
    targetAnswer = 'Yes';
    targetIndex = activeOptions.findIndex((o) => /yes|true|attend|agree|willing|sure/i.test(o));
    if (targetIndex < 0 && activeOptions.length > 0) {
      targetIndex = 0;
      targetAnswer = activeOptions[0];
    }
  }

  // 5. Negative background / legal / sponsorship questions
  else if (/criminal|felon|convict|disciplinary|sponsorship|visa support/i.test(questionText)) {
    targetAnswer = 'No';
    targetIndex = activeOptions.findIndex((o) => /no|false|never|none/i.test(o));
    if (targetIndex < 0 && activeOptions.length > 0) {
      targetIndex = activeOptions.findIndex((o) => !/yes/i.test(o));
    }
  }

  // 6. General Yes/No & Willingness questions (willingness, relocate, ready to, comfortable, can you, will you, etc.)
  else if (/(?:will|can|do|are|would|is|have)\s+you|willing|able|ready to|comfortable|okay with|open to|authorized|agree/i.test(questionText)) {
    targetAnswer = 'Yes';
    targetIndex = activeOptions.findIndex((o) => /yes|true|agree|willing/i.test(o));
    if (targetIndex < 0 && activeOptions.length > 0) {
      targetIndex = 0;
      targetAnswer = activeOptions[0];
    }
  }

  // 7. Experience / years questions
  else if (/experience|years|yoe|how many.*year/i.test(questionText)) {
    const candidateYears = profile.yearsExperience || profile.yearsOfExperience || 4;
    targetIndex = matchExperienceOption(activeOptions, candidateYears);
    if (targetIndex >= 0 && targetIndex < activeOptions.length) {
      targetAnswer = activeOptions[targetIndex];
    }
  }

  // 8. Notice period / serving notice / joining
  else if (/notice period|serving notice|lwd|last working|joining/i.test(questionText)) {
    targetAnswer = '15 Days';
    targetIndex = activeOptions.findIndex((o) => o.includes('15') || o.toLowerCase().includes('immediate') || o.includes('< 15') || o.includes('0-15'));
    if (targetIndex < 0 && activeOptions.length > 0) {
      targetIndex = 0;
      targetAnswer = activeOptions[0];
    }
  }

  // 9. Employment type (Full-time / Part-time / Contract)
  else if (/employment type|full.?time|part.?time/i.test(questionText)) {
    targetAnswer = 'Full-time';
    targetIndex = activeOptions.findIndex((o) => o.toLowerCase().includes('full'));
    if (targetIndex < 0 && activeOptions.length > 0) {
      targetIndex = 0;
      targetAnswer = activeOptions[0];
    }
  }

  // Default fallback: pick via Gemini or first non-skip option
  if (targetIndex < 0 && activeOptions.length > 0) {
    try {
      const geminiChoice = await resolveScreeningQuestionWithGemini(
        questionText,
        'radio',
        activeOptions,
        profile
      );
      if (geminiChoice) {
        const found = activeOptions.findIndex(
          (o) => o.trim().toLowerCase() === geminiChoice.toLowerCase() || o.toLowerCase().includes(geminiChoice.toLowerCase())
        );
        if (found >= 0) {
          targetIndex = found;
          targetAnswer = activeOptions[found];
        }
      }
    } catch {}

    if (targetIndex < 0) {
      targetIndex = activeOptions.findIndex((o) => !/skip|decline|none of/i.test(o));
      if (targetIndex < 0) targetIndex = 0;
      targetAnswer = activeOptions[targetIndex];
    }
  }

  if (targetIndex < 0 && !targetAnswer) return false;

  // Tier 1: Direct Playwright label click with force: true
  if (targetAnswer) {
    try {
      const labelLoc = page.locator(
        `${CHATBOT_DRAWER} label.ssrc__label:has-text("${targetAnswer}"), ${CHATBOT_DRAWER} label:has-text("${targetAnswer}"), ${CHATBOT_DRAWER} .singleselect-radiobutton:has-text("${targetAnswer}")`
      ).first();
      if ((await labelLoc.count()) > 0 && (await labelLoc.isVisible().catch(() => false))) {
        await labelLoc.scrollIntoViewIfNeeded().catch(() => {});
        await labelLoc.click({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(150);
      }
    } catch {}
  }

  // Tier 2: Direct Playwright radio check with force: true
  if (targetAnswer) {
    try {
      const radioLoc = page.locator(
        `${CHATBOT_DRAWER} input[type="radio"][value="${targetAnswer}" i], ${CHATBOT_DRAWER} input[type="radio"]:has(+ label:has-text("${targetAnswer}"))`
      ).first();
      if ((await radioLoc.count()) > 0) {
        await radioLoc.scrollIntoViewIfNeeded().catch(() => {});
        await radioLoc.check({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(150);
      }
    } catch {}
  }

  // Tier 3: Playwright getByRole('radio')
  if (targetAnswer) {
    try {
      const escaped = targetAnswer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const roleLoc = page.getByRole('radio', { name: new RegExp(`^\\s*${escaped}\\s*$`, 'i') }).first();
      if ((await roleLoc.count()) > 0) {
        await roleLoc.check({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(150);
      }
    } catch {}
  }

  // Tier 4: In-page JS evaluation with trusted event emulation and Naukri chatbot send-button activation
  const clickedInJs = await page.evaluate(({ tAnswer, tIndex }) => {
    const drawer = document.querySelector(
      'div.chatbot_DrawerContentWrapper, div[class*="chatbot" i], div[class*="drawer" i], div[class*="applyDrawer" i], div[class*="apply-container" i]'
    ) || document.body;

    const allRadios = Array.from(drawer.querySelectorAll<HTMLInputElement>('input[type="radio"], [role="radio"]'));
    const allLabels = Array.from(drawer.querySelectorAll(
      'label.ssrc__label, .singleselect-radiobutton, .ssrc__radio-btn-container, label[class*="radio" i], div[class*="radio" i], div[class*="singleselect" i], [class*="radio-item" i], label'
    ));

    type OptionEntry = {
      element: HTMLElement;
      radio: HTMLInputElement | null;
      text: string;
      value: string;
    };

    const optionsList: OptionEntry[] = [];

    for (const r of allRadios) {
      let text = '';
      if (r.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
        if (lbl) text = lbl.textContent || '';
      }
      if (!text) {
        const parentLbl = r.closest('label');
        if (parentLbl) text = parentLbl.textContent || '';
      }
      if (!text) {
        const sib = r.nextElementSibling;
        if (sib) text = sib.textContent || '';
      }
      if (!text) text = r.value || r.getAttribute('aria-label') || '';
      text = text.replace(/\s+/g, ' ').trim();
      optionsList.push({
        element: r.closest('label') || r.parentElement || r,
        radio: r,
        text,
        value: r.value || '',
      });
    }

    for (const l of allLabels) {
      const r = l.querySelector<HTMLInputElement>('input[type="radio"]') || (l instanceof HTMLInputElement && l.type === 'radio' ? l : null);
      const text = (l.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && !optionsList.some((o) => o.element === l || (r && o.radio === r))) {
        optionsList.push({
          element: l as HTMLElement,
          radio: r,
          text,
          value: r?.value || '',
        });
      }
    }

    let chosen: OptionEntry | undefined;
    if (tAnswer) {
      const lower = tAnswer.toLowerCase().trim();
      chosen = optionsList.find((o) => o.text.toLowerCase() === lower || o.value.toLowerCase() === lower);
      if (!chosen && (lower === 'yes' || lower === 'no')) {
        chosen = optionsList.find((o) => new RegExp(`^${lower}\\b`, 'i').test(o.text) || new RegExp(`^${lower}\\b`, 'i').test(o.value));
      }
      if (!chosen) {
        chosen = optionsList.find((o) => o.text.toLowerCase().includes(lower) || lower.includes(o.text.toLowerCase()));
      }
    }

    if (!chosen && tIndex >= 0 && tIndex < optionsList.length) {
      chosen = optionsList[tIndex];
    }

    if (!chosen && optionsList.length > 0) {
      chosen = optionsList[0];
    }

    if (chosen) {
      const { element, radio } = chosen;
      element.scrollIntoView({ block: 'nearest' });
      element.click();

      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        radio.dispatchEvent(new Event('click', { bubbles: true }));
      }

      if (element.getAttribute('role') === 'radio') {
        element.setAttribute('aria-checked', 'true');
        element.dispatchEvent(new Event('click', { bubbles: true }));
      }

      // Un-disable save/send buttons in Naukri chatbot
      const sendBtns = drawer.querySelectorAll('div.send, [class*="send" i], [class*="save" i], button');
      sendBtns.forEach((b) => b.classList.remove('disabled'));

      return true;
    }
    return false;
  }, { tAnswer: targetAnswer, tIndex: targetIndex }).catch(() => false);

  if (clickedInJs) {
    await page.waitForTimeout(300);
    return true;
  }

  // Tier 5: Fallback locator by index
  try {
    const labels = page.locator(`${CHATBOT_DRAWER} label.ssrc__label, ${CHATBOT_DRAWER} .singleselect-radiobutton, ${CHATBOT_DRAWER} input[type="radio"]`);
    const count = await labels.count();
    if (targetIndex >= 0 && targetIndex < count) {
      await labels.nth(targetIndex).click({ force: true, timeout: 2000 });
      await page.waitForTimeout(300);
      return true;
    }
  } catch {}

  return false;
}

/**
 * Answer a multi-select checkbox question in the Naukri chatbot.
 */
export async function answerCheckboxQuestion(
  page: Page,
  questionText: string,
  profile: CandidateProfile,
): Promise<boolean> {
  try {
    const container = page.locator(`${CHATBOT_DRAWER} div.multiselectcheckboxes, div.multiselectcheckboxes, div.multicheckboxes-container`).first();
    if ((await container.count()) === 0) return false;

    // Get all option labels
    const labels = container.locator('label.mcc__label, label');
    const labelCount = await labels.count();
    if (labelCount === 0) return false;

    const options: { index: number; text: string }[] = [];
    for (let i = 0; i < labelCount; i++) {
      const text = (await labels.nth(i).innerText().catch(() => '')).trim();
      if (text) options.push({ index: i, text });
    }

    console.log('[naukri] Checkbox question options:', options.map((o) => o.text));

    let selected = false;
    const q = questionText.toLowerCase();

    if (/location|city/i.test(q)) {
      // Preferred locations: check candidate preferred locations or standard metro hubs
      const preferred = ['bengaluru', 'bangalore', 'pune', 'hyderabad', 'chennai', 'gurugram', 'gurgaon', 'noida', 'delhi'];
      if (profile.location) {
        preferred.unshift(profile.location.split(',')[0].trim().toLowerCase());
      }
      for (const pref of preferred) {
        const match = options.find((o) => o.text.toLowerCase().includes(pref));
        if (match) {
          console.log(`[naukri] Selecting location checkbox option: "${match.text}"`);
          await labels.nth(match.index).click({ timeout: 2000 });
          selected = true;
          break;
        }
      }
    } else {
      // Match non-skip options
      const nonSkipOptions = options.filter((o) => !/skip/i.test(o.text));
      if (nonSkipOptions.length > 0) {
        console.log(`[naukri] Selecting first valid checkbox option: "${nonSkipOptions[0].text}"`);
        await labels.nth(nonSkipOptions[0].index).click({ timeout: 2000 });
        selected = true;
      }
    }

    // Fallback to "Skip this question" if present and nothing else selected
    if (!selected) {
      const skipOption = options.find((o) => /skip/i.test(o.text));
      if (skipOption) {
        console.log('[naukri] Selecting "Skip this question" checkbox option');
        await labels.nth(skipOption.index).click({ timeout: 2000 });
        selected = true;
      }
    }

    await page.waitForTimeout(500);
    return selected;
  } catch (err) {
    console.warn('[naukri] Error answering checkbox question:', err);
    return false;
  }
}

/**
 * Answer a skill chips question by clicking matching or first skill tag.
 */
export async function answerSkillChipsQuestion(
  page: Page,
  profile: CandidateProfile,
): Promise<boolean> {
  try {
    const chips = page.locator(CHATBOT_SKILL_CHIPS);
    const count = await chips.count();
    if (count === 0) return false;

    const userSkills = [
      ...(Array.isArray(profile.skills) ? profile.skills : []),
      ...(Array.isArray(profile.keySkills) ? profile.keySkills : []),
      ...(profile.title ? [profile.title] : []),
    ].map((s) => String(s).toLowerCase());

    let clicked = false;
    for (let i = 0; i < count; i++) {
      const chip = chips.nth(i);
      const text = (await chip.innerText().catch(() => '')).trim();
      if (!text) continue;

      const lowerText = text.toLowerCase();
      const matches = userSkills.some((s) => lowerText.includes(s) || s.includes(lowerText));
      if (matches || userSkills.length === 0 || i === 0) {
        await chip.click({ timeout: 2000 }).catch(() => {});
        clicked = true;
        await page.waitForTimeout(300);
      }
    }

    if (!clicked && count > 0) {
      await chips.first().click({ timeout: 2000 }).catch(() => {});
      clicked = true;
    }

    await page.waitForTimeout(500);
    return clicked;
  } catch (err) {
    console.warn('[naukri] Error answering skill chips question:', err);
    return false;
  }
}

/**
 * Answer a custom dropdown / searchable location question in Naukri chatbot.
 */
export async function answerCustomDropdownQuestion(
  page: Page,
  questionText: string,
  profile: CandidateProfile,
): Promise<boolean> {
  try {
    const dropdownInput = page.locator(CHATBOT_CUSTOM_DROPDOWN).first();
    if ((await dropdownInput.count()) === 0) return false;

    const targets = profile.targets as { locations?: string[] } | undefined;
    const targetLocation = (profile.location as string) || (targets?.locations?.[0]) || 'Bengaluru';
    const city = targetLocation.split(',')[0].trim();

    await dropdownInput.scrollIntoViewIfNeeded().catch(() => {});
    await dropdownInput.click({ timeout: 3000 });
    await page.waitForTimeout(300);

    // Clear and type city name
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(city, { delay: 40 });
    await page.waitForTimeout(600);

    // Click the first matching option suggestion in the dropdown popup
    const optionLocators = [
      `${CHATBOT_DRAWER} ul li`,
      `${CHATBOT_DRAWER} div[class*="option"]`,
      `${CHATBOT_DRAWER} div[class*="item"]`,
      `${CHATBOT_DRAWER} div.droppable div`,
      'ul.dropdown li',
      'div[class*="suggestion"]',
      'div[class*="dropdown-item"]',
    ];

    for (const sel of optionLocators) {
      try {
        const firstOpt = page.locator(sel).first();
        if ((await firstOpt.count()) > 0 && (await firstOpt.isVisible().catch(() => false))) {
          await firstOpt.click({ timeout: 2000 });
          await page.waitForTimeout(500);
          return true;
        }
      } catch {
        // continue
      }
    }

    // Fallback: press Enter or Down Arrow + Enter
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    return true;
  } catch (err) {
    console.warn('[naukri] Error answering custom dropdown question:', err);
    return false;
  }
}

/**
 * Deterministically resolve a text answer for a Naukri chatbot screening question.
 */
export function resolveChatbotTextAnswer(
  questionText: string,
  profile: CandidateProfile,
  companyName?: string,
): string {
  const q = questionText.trim();

  // 1. Ex-employee / previous employee / employee ID / re-hire questions
  const isExEmployeeQuestion =
    /ex[- ](employee|emp|infosys|tcs|wipro|cognizant|accenture|hcl|tech mahindra|capgemini)|former employee|previous employee|past employee|employee id|emp id|previously worked|worked with us|worked at/i.test(q);

  if (isExEmployeeQuestion) {
    const targetComp = (companyName || '').toLowerCase();
    const candidatePastCompanies = [
      profile.currentCompany || '',
      ...(Array.isArray(profile.experience) ? profile.experience : []).map((e) => (typeof e === 'string' ? e : '')),
    ].join(' ').toLowerCase();

    const workedAtCompany = targetComp && candidatePastCompanies.includes(targetComp);
    if (!workedAtCompany) {
      if (/write\s*na|else\s*na|otherwise\s*na|\bor\s*na\b/i.test(q)) {
        return 'NA';
      }
      if (/employee\s*id|emp\s*id/i.test(q)) {
        return 'NA';
      }
      if (/^are you|^have you/i.test(q.trim())) {
        return 'No';
      }
      return 'NA';
    }
  }

  // 2. Questions explicitly instructing to write/enter NA if not applicable / none
  if (/(?:if not|else|otherwise|or)\s*,?\s*(?:write|enter|type)?\s*na\b/i.test(q)) {
    // If not a core personal identity field, safe default is NA
    if (!/email|phone|mobile|\byour\s*name\b|full\s*name|total\s*exp/i.test(q)) {
      return 'NA';
    }
  }

  // 3. Contact & identity
  if (/\bemail\b/i.test(q)) return profile.email || '';
  if (/\b(phone|mobile|contact number)\b/i.test(q)) return profile.phone || '';
  if (/\b(full\s*name|your\s*name|candidate\s*name)\b/i.test(q) || (/name/i.test(q) && !/company|employer/i.test(q))) {
    return profile.name || '';
  }
  if (/\blinkedin\b/i.test(q)) return profile.linkedin || '';
  if (/\b(github|portfolio|website)\b/i.test(q)) return profile.portfolioUrl || '';

  // 4. Notice period / LWD / Joining time
  if (/notice period|serving notice|last working day|lwd|how soon can you join/i.test(q)) {
    const days = profile.noticePeriodDays ?? (profile.notice_period_days as number) ?? 30;
    if (/in days|\bdays\b/i.test(q)) return String(days);
    return `${days} Days`;
  }

  // 5. Current CTC / Compensation (e.g. "What is your current CTC in Lacs per annum?")
  if (/current\s*(ctc|salary|compensation|fixed|take home|package)|present\s*(ctc|salary)/i.test(q)) {
    const inr = (profile.currentCtcInr as number | undefined) ?? (profile.current_ctc_inr as number | undefined);
    const targetMin = (profile.targets as any)?.comp_min;
    const val = inr || targetMin || 700000;
    const lakhs = val / 100000;
    const formattedLakhs = lakhs % 1 === 0 ? String(lakhs) : Number(lakhs.toFixed(2)).toString();
    if (/(?:in lpa|\blpa\b|lakhs?|lacs?)/i.test(q)) {
      return formattedLakhs;
    }
    if (/(?:in inr|in ₹|rupees|digits|numbers?)/i.test(q)) {
      return String(val);
    }
    return formattedLakhs;
  }

  // 6. Expected CTC / Compensation
  if (/expected\s*(ctc|salary|compensation|package)|salary expectation/i.test(q)) {
    const targets = profile.targets as { comp_min?: number; locations?: string[] } | undefined;
    const inr = (profile.expectedCtcInr as number | undefined) ?? (profile.expected_ctc_inr as number | undefined) ?? targets?.comp_min;
    const val = inr || 1200000;
    const lakhs = val / 100000;
    const formattedLakhs = lakhs % 1 === 0 ? String(lakhs) : Number(lakhs.toFixed(2)).toString();
    if (/(?:in lpa|\blpa\b|lakhs?|lacs?)/i.test(q)) {
      return formattedLakhs;
    }
    if (/(?:in inr|in ₹|rupees|digits|numbers?)/i.test(q)) {
      return String(val);
    }
    return formattedLakhs;
  }

  // 7. Experience / Years (e.g. "How many years of experience do you have in Power Bi?", "Years of experience in Python")
  if (/(?:total|relevant|overall|years of|work)?\s*(?:experience|exp|yoe)\b|how many years|years in\b/i.test(q)) {
    const expList = Array.isArray(profile.experience) ? profile.experience : [];
    const rawYoe = (profile.yearsOfExperience as number) ?? (profile.yearsExperience as number) ?? (expList.length ? Math.max(1, expList.length * 2) : 3);
    const numYoe = Number(rawYoe);
    return !isNaN(numYoe) && numYoe >= 0 ? String(Math.floor(numYoe)) : '3';
  }

  // 8. Location & Relocation
  if (/willing to relocate|ready to relocate|comfortable to relocate|open to relocate/i.test(q)) {
    return 'Yes';
  }
  const cityResidence = matchCityResidenceQuestion(q, profile.location as string | undefined);
  if (cityResidence) {
    return cityResidence.answer;
  }
  if (/current location|current city|where are you (currently )?(living|located|residing|based)/i.test(q)) {
    return (profile.location as string) || '';
  }
  if (/preferred location|preferred city/i.test(q)) {
    const targets = profile.targets as { locations?: string[] } | undefined;
    return (targets?.locations && targets.locations.length > 0) ? targets.locations[0] : ((profile.location as string) || '');
  }
  if (/work from office|wfo|hybrid|on[- ]?site|in[- ]?office/i.test(q)) {
    return 'Yes';
  }

  // 9. Current Company / Title
  if (/current (organization|company|employer)|present (organization|company|employer)/i.test(q)) {
    return (profile.currentCompany as string) || '';
  }
  if (/current (role|job title|designation)|present (role|job title|designation)/i.test(q)) {
    return (profile.currentJobTitle as string) || (profile.title as string) || '';
  }

  // 10. Education / College / Years
  if (/highest (qualification|education|degree)|qualification|degree/i.test(q)) {
    const edu = Array.isArray(profile.education) ? profile.education : [];
    return edu.length > 0 ? String(edu[0]) : ((profile.degree as string) || (profile.qualification as string) || 'Bachelor Degree');
  }
  if (/starting year|start year|admission year/i.test(q)) {
    const eduStr = JSON.stringify(profile.education || []);
    const match = eduStr.match(/(\b20\d\d\b|\b19\d\d\b)/);
    if (match) return match[1];
    return '2016';
  }
  if (/pass(ing)? out year|graduation year|year of graduation|completion year|end year/i.test(q)) {
    const eduStr = JSON.stringify(profile.education || []);
    const matches = eduStr.match(/(\b20\d\d\b|\b19\d\d\b)/g);
    if (matches && matches.length > 0) return matches[matches.length - 1];
    return '2020';
  }

  // 11. Willingness / Yes-No prompts
  if (/willing|ready|able|can you|agree/i.test(q)) {
    return 'Yes';
  }

  // 12. Certifications
  if (/certification|certified/i.test(q)) {
    return 'NA';
  }

  return '';
}

/**
 * Click the optional "Skip this question" button in the chatbot if present.
 */
export async function clickChatbotSkip(page: Page): Promise<boolean> {
  const skipSelectors = [
    `${CHATBOT_DRAWER} button:has-text("Skip this question")`,
    `${CHATBOT_DRAWER} span:has-text("Skip this question")`,
    `${CHATBOT_DRAWER} div:has-text("Skip this question"):not(:has(div))`,
    `${CHATBOT_DRAWER} [class*="skip" i]`,
    'button:has-text("Skip this question")',
    'span:has-text("Skip this question")',
    'div:has-text("Skip this question"):not(:has(div))',
    'button:has-text("Skip")',
    '.skip-btn',
    '[class*="skipBtn"]',
  ];

  for (const sel of skipSelectors) {
    try {
      const skipBtn = page.locator(sel).first();
      if ((await skipBtn.count()) > 0 && (await skipBtn.isVisible().catch(() => false))) {
        console.log('[naukri] Clicking Skip button in chatbot via selector:', sel);
        await skipBtn.click({ timeout: 3000 });
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {
      // continue
    }
  }
  return false;
}

/**
 * Type an answer into the Naukri chatbot input field (contenteditable div or input)
 * and trigger React input events so the Save button becomes active.
 */
async function typeIntoChatbotInput(page: Page, answer: string): Promise<boolean> {
  try {
    const textToType = answer.trim();
    if (!textToType) return false;

    // 1. Locate the input using Playwright and click to focus
    const inputLoc = page.locator(CHATBOT_TEXT_INPUT).first();
    let hasLoc = false;
    if ((await inputLoc.count()) > 0 && (await inputLoc.isVisible().catch(() => false))) {
      hasLoc = true;
      if (typeof (inputLoc as any).scrollIntoViewIfNeeded === 'function') {
        await (inputLoc as any).scrollIntoViewIfNeeded().catch(() => {});
      }
      await inputLoc.click({ timeout: 2000 }).catch(() => {});
    }

    // 2. Set value directly in DOM and trigger React input/change events
    const filledInJs = await page.evaluate((val) => {
      const drawer = document.querySelector(
        'div.chatbot_DrawerContentWrapper, div[class*="chatbot" i], div[class*="drawer" i], div[class*="applyDrawer" i], div[class*="apply-container" i]'
      );
      const root = drawer || document;

      // Select all candidate editable inputs inside drawer or root
      const candidates = Array.from(root.querySelectorAll<HTMLElement>(
        'div[contenteditable="true"], input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]), textarea'
      ));

      let target: HTMLElement | null = null;
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          target = el;
          break;
        }
      }

      if (!target) return false;

      target.focus();

      // Handle integer rounding if number input with integer step
      let cleanVal = val;
      if (target instanceof HTMLInputElement && target.type === 'number') {
        const step = target.getAttribute('step');
        const num = Number(val);
        if (!isNaN(num) && step === '1' && !Number.isInteger(num)) {
          cleanVal = String(Math.round(num));
        }
      }

      // Native property setter + Synthetic Events for React
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        const proto = Object.getPrototypeOf(target);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(target, cleanVal);
        } else {
          target.value = cleanVal;
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (target.isContentEditable) {
        target.innerText = cleanVal;
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: cleanVal }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // Enable send button if present
      const sendBtns = root.querySelectorAll('div.send, [class*="send" i], [class*="save" i], [class*="submit" i]');
      sendBtns.forEach((btn) => btn.classList.remove('disabled'));

      return true;
    }, textToType).catch(() => false);

    // 3. Native keyboard typing to guarantee React state updates
    if (page.keyboard) {
      try {
        if (hasLoc) {
          await inputLoc.click({ timeout: 1500 }).catch(() => {});
        }
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.keyboard.type(textToType, { delay: 15 }).catch(() => {});
        await page.waitForTimeout(100);
      } catch {
        // evaluate already set value
      }
    }

    return Boolean(filledInJs || hasLoc);
  } catch (err) {
    console.warn('[naukri] Error typing into chatbot input:', err);
    return false;
  }
}

/**
 * Extract DOM field constraints (inputMode, pattern, maxLength, isNumeric, errorMessage)
 * from active Naukri chatbot input field.
 */
export async function extractNaukriDOMConstraints(page: Page): Promise<FieldConstraints> {
  try {
    return await page.evaluate(() => {
      const drawer = document.querySelector(
        'div.chatbot_DrawerContentWrapper, div[class*="chatbot" i], div[class*="drawer" i], div[class*="applyDrawer" i], div[class*="apply-container" i]'
      );
      const root = drawer || document;
      const el = root.querySelector(
        'div[contenteditable="true"], input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]), textarea'
      ) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;

      if (!el) return {};

      const inputMode = el.getAttribute('inputmode') || (el as HTMLInputElement).inputMode || '';
      const pattern = el.getAttribute('pattern') || '';
      const rawMax = el.getAttribute('maxlength') || el.getAttribute('max_length') || '';
      const maxLength = rawMax ? parseInt(rawMax, 10) : undefined;
      const type = (el as HTMLInputElement).type || '';

      const isNumeric =
        inputMode === 'numeric' ||
        inputMode === 'decimal' ||
        inputMode === 'tel' ||
        type === 'number' ||
        type === 'tel' ||
        pattern.includes('0-9') ||
        pattern.includes('\\d');

      const errorEl = root.querySelector(
        '[class*="error" i], [class*="invalid" i], .artdeco-inline-feedback--error, div.errorMsg'
      );
      const errorMessage = errorEl ? (errorEl.textContent || '').trim() : undefined;

      return {
        inputMode,
        pattern,
        maxLength: maxLength && !isNaN(maxLength) ? maxLength : undefined,
        isNumeric,
        errorMessage,
      };
    });
  } catch {
    return {};
  }
}

/**
 * Answer a text input question by typing into the input field or skipping if optional.
 * Delegates custom screening questions and constrained fields to Gemini.
 */
export async function answerTextQuestion(
  page: Page,
  questionText: string,
  profile: CandidateProfile,
  companyName?: string,
  jobTitle?: string,
  retryErrorMessage?: string,
): Promise<boolean> {
  const constraints = await extractNaukriDOMConstraints(page);
  if (retryErrorMessage) {
    constraints.errorMessage = retryErrorMessage;
  }

  const isCtcQuestion =
    /(?:current|present|expected)?\s*(?:ctc|salary|compensation|package)|salary expectation/i.test(questionText);
  const isYearsOrExpQuestion =
    /(?:how many\s+)?(?:years|months|days)(?:\s+of)?(?:\s+experience|\s+exp)?\b|experience in\b|years in\b|\byoe\b/i.test(questionText);
  const isStandardProfileQuestion =
    isCtcQuestion ||
    isYearsOrExpQuestion ||
    /notice period|serving notice|last working day|lwd|how soon/i.test(questionText) ||
    /\b(email|phone|mobile|name|linkedin|portfolio)\b/i.test(questionText) ||
    /willing to relocate|ready to relocate|current location|where are you|residing/i.test(questionText) ||
    /ex[- ](employee|emp)|former employee|previous employee/i.test(questionText);

  // 1. Try deterministic heuristics for standard profile fields
  const heuristicAnswer = resolveChatbotTextAnswer(questionText, profile, companyName);

  let answer: string | null = null;

  // If question is a standard profile field and heuristic gave a clean answer, use it directly!
  if (isStandardProfileQuestion && heuristicAnswer && !retryErrorMessage) {
    answer = heuristicAnswer;
  } else if (!heuristicAnswer || constraints.isNumeric || constraints.errorMessage || /experience in|role|tech stack|how many|years|skills/i.test(questionText)) {
    if (isYearsOrExpQuestion || isCtcQuestion) {
      constraints.isNumeric = true;
    }
    answer = await resolveScreeningQuestionWithGemini(
      questionText,
      'text',
      [],
      profile,
      constraints
    );
  }

  if (!answer) {
    answer = heuristicAnswer;
  }

  if (!answer) {
    if (/(?:if not|else|otherwise|or)\s*,?\s*(?:write|enter|type)?\s*na\b/i.test(questionText)) {
      answer = 'NA';
    } else if (/^(?:are\s+you|do\s+you|can\s+you|will\s+you|have\s+you|is\s+there|would\s+you|did\s+you)\b/i.test(questionText.trim())) {
      answer = /ex[- ]employee|former employee|criminal|convict|backlog|bond|disciplinary/i.test(questionText) ? 'No' : 'Yes';
    } else {
      answer = 'NA';
    }
  }

  // 2. Format / sanitize answers according to question semantics
  if (isCtcQuestion) {
    // Format CTC strictly in Lacs (e.g. 5.25 or 12)
    const match = answer.match(/\d+(?:\.\d+)?/);
    if (match) {
      const val = parseFloat(match[0]);
      if (val > 200) {
        // Full INR entered (e.g. 525000) -> convert to Lakhs
        answer = Number((val / 100000).toFixed(2)).toString();
      } else {
        answer = Number(val.toFixed(2)).toString();
      }
    } else if (heuristicAnswer) {
      answer = heuristicAnswer;
    }
  } else if (isYearsOrExpQuestion) {
    const digits = answer.replace(/\D/g, '');
    answer = digits || (heuristicAnswer && /^\d+$/.test(heuristicAnswer) ? heuristicAnswer : '3');
  } else if (constraints.isNumeric && !/^\d+$/.test(answer)) {
    const digits = answer.replace(/\D/g, '');
    if (digits) answer = digits;
  }

  // 3. Type answer into chatbot text input
  const typed = await typeIntoChatbotInput(page, answer);
  if (!typed) {
    const skipped = await clickChatbotSkip(page);
    if (skipped) return true;
  }
  return typed;
}

/**
 * Click the chatbot's save/next button.
 */
async function clickChatbotSave(page: Page): Promise<boolean> {
  try {
    // 1. Press Enter on keyboard if available (primary trigger for chatbot text inputs)
    if (page.keyboard) {
      try {
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(300);
      } catch {}
    }

    // 2. Playwright locator click on save/send buttons (generates trusted mouse events)
    const saveSelectors = [
      `${CHATBOT_DRAWER} div.send div.sendMsg`,
      `${CHATBOT_DRAWER} div.sendMsg`,
      `${CHATBOT_DRAWER} button:has-text("Save")`,
      `${CHATBOT_DRAWER} button:has-text("Next")`,
      `${CHATBOT_DRAWER} button:has-text("Submit")`,
      `${CHATBOT_DRAWER} button:has-text("Apply")`,
      `${CHATBOT_DRAWER} button[type="submit"]`,
      `${CHATBOT_DRAWER} div.send`,
      `${CHATBOT_DRAWER} [class*="sendBtn" i]`,
      `${CHATBOT_DRAWER} [class*="saveBtn" i]`,
      'div.send div.sendMsg',
      'div.sendMsg',
      'button:has-text("Save")',
      'button:has-text("Next")',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      'button[type="submit"]',
      'div.send',
    ];

    for (const sel of saveSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.click({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(400);
          return true;
        }
      } catch {}
    }

    // 3. Fallback: JS click inside evaluate, prioritizing child sendMsg over outer send
    const clickedInJs = await page.evaluate(() => {
      const drawer = document.querySelector('div.chatbot_DrawerContentWrapper, div[class*="chatbot" i], div[class*="drawer" i], div[class*="applyDrawer" i], div[class*="apply-container" i]');
      const root = drawer || document;

      // Enable send div if disabled
      const sendDiv = root.querySelector('div.send');
      if (sendDiv) {
        sendDiv.classList.remove('disabled');
      }

      // Prioritize clicking send msg div or save button over the outer send wrapper
      const clickables = Array.from(root.querySelectorAll('div.sendMsg, button, [class*="send" i], [class*="save" i], [class*="submit" i], div.send'));
      for (const el of clickables) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text === 'save' || text === 'next' || text === 'send' || text === 'submit' || text === 'apply' || el.classList.contains('sendMsg') || el.classList.contains('send')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            (el as HTMLElement).click();
            return true;
          }
        }
      }
      return false;
    }).catch(() => false);

    if (clickedInJs) {
      await page.waitForTimeout(400);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Upload resume to the Naukri chatbot file input.
 */
async function uploadNaukriResume(
  page: Page,
  resumeFilename: string,
  resumeBytes: Uint8Array,
): Promise<boolean> {
  const file = {
    name: resumeFilename,
    mimeType: 'application/pdf',
    buffer: Buffer.from(resumeBytes),
  };

  try {
    // Strategy 1: Chatbot file input
    const chatbotFile = page.locator(`${CHATBOT_DRAWER} ${CHATBOT_FILE_UPLOAD}`).first();
    if ((await chatbotFile.count()) > 0) {
      await chatbotFile.setInputFiles(file);
      return true;
    }

    // Strategy 2: Standard file input on page
    const standardFile = page.locator('input[type="file"][name*="resume" i], input[type="file"][id*="resume" i]').first();
    if ((await standardFile.count()) > 0) {
      await standardFile.setInputFiles(file);
      return true;
    }

    // Strategy 3: Any visible file input (force visible if hidden)
    const anyFile = page.locator('input[type="file"]').first();
    if ((await anyFile.count()) > 0) {
      // Force visible via JS (Naukri sometimes hides file inputs)
      await anyFile.evaluate((el) => { (el as HTMLElement).style.display = 'block !important'; }).catch(() => {});
      await anyFile.setInputFiles(file);
      return true;
    }

    // Strategy 4: Click upload button and intercept file chooser
    const uploadBtn = page.locator('button:has-text("Upload"), a:has-text("Upload"), button:has-text("Attach"), a:has-text("Attach")').first();
    if ((await uploadBtn.count()) > 0) {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        uploadBtn.click(),
      ]).catch(() => [null]);
      if (fileChooser) {
        await fileChooser.setFiles(file);
        return true;
      }
    }
  } catch {
    // continue
  }

  return false;
}

// ----- Main entry point ------------------------------------------------------

/**
 * Detect whether the current chatbot question step is the final step before application completion.
 */
async function isFinalChatbotQuestion(
  page: Page,
  questionText: string,
  currentStep: number,
): Promise<boolean> {
  try {
    const lowerQ = questionText.toLowerCase();

    // 1. Explicit keywords indicating final step or submission message
    if (/final question|last question|one last|before you submit|confirm application|ready to apply|thank you|responses recorded/i.test(lowerQ)) {
      return true;
    }

    // 2. Button text check (e.g. "Submit", "Apply", "Finish", "Complete")
    const saveBtnText = await page.locator(CHATBOT_SAVE_BUTTON).first().innerText().catch(() => '');
    if (/submit|apply|finish|complete/i.test(saveBtnText)) {
      return true;
    }

    // 3. Step indicator check in drawer text (e.g. "2 of 2", "3/3", "Step 2 of 2")
    const drawerText = await page.locator(CHATBOT_DRAWER).innerText().catch(() => '');
    const stepMatch = drawerText.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
    if (stepMatch) {
      const stepNum = parseInt(stepMatch[1], 10);
      const totalSteps = parseInt(stepMatch[2], 10);
      if (stepNum >= totalSteps) {
        return true;
      }
    }

    // 4. Count interactive inputs remaining in drawer
    const botMessages = page.locator(CHATBOT_MESSAGE);
    const msgCount = await botMessages.count();

    const interactiveInputs = page.locator(
      `${CHATBOT_DRAWER} :is(${CHATBOT_TEXT_INPUT}, ${CHATBOT_RADIO}, ${CHATBOT_CHECKBOX}, ${CHATBOT_SKILL_CHIPS})`
    );
    const inputCount = await interactiveInputs.count();

    // If only 1 input group is visible and no step progress indicates more
    if (inputCount <= 1 && !/next question/i.test(drawerText)) {
      if (!stepMatch && msgCount <= 1) {
        return true;
      }
    }
  } catch {
    // Default to true in manual apply mode if uncertain
  }
  return false;
}

const MAX_CHATBOT_STEPS = 15;

/**
 * Handle the Naukri chatbot apply flow: detect questions, answer them,
 * upload resume when prompted, and stop when the chatbot completes.
 */
/**
 * When LLM or rule-based answering cannot answer a chatbot question,
 * focus Chrome and watch for user cursor movement or keyboard entry.
 * If user responds, wait for them to finish; if no user action, return 'no_response' so the job can be skipped.
 */
async function waitForUserIntervention(
  page: Page,
  questionText: string,
  timeoutMs = 20000,
): Promise<'user_answered' | 'no_response'> {
  console.log(`[naukri] Watching cursor/keyboard activity for unanswered question: "${questionText.slice(0, 40)}..." (${timeoutMs / 1000}s timer)...`);
  await focusApplyPage(page, true);

  await page.evaluate(() => {
    (window as any).__hireme_user_activity = false;
    const handler = () => { (window as any).__hireme_user_activity = true; };
    window.addEventListener('mousemove', handler, { once: true });
    window.addEventListener('keydown', handler, { once: true });
    window.addEventListener('click', handler, { once: true });
  }).catch(() => {});

  const startTime = Date.now();
  let userActive = false;

  while (Date.now() - startTime < timeoutMs) {
    if (isApplyCancelled()) break;

    userActive = await page.evaluate(() => Boolean((window as any).__hireme_user_activity)).catch(() => false);
    if (userActive) {
      console.log('[naukri] User cursor/keyboard activity detected! Giving user time to answer manually...');
      break;
    }

    const submitted = await detectNaukriApplicationSubmitted(page).catch(() => false);
    if (submitted) return 'user_answered';

    await page.waitForTimeout(500);
  }

  if (userActive) {
    const extendedStart = Date.now();
    while (Date.now() - extendedStart < 40_000) {
      if (isApplyCancelled()) break;
      const submitted = await detectNaukriApplicationSubmitted(page).catch(() => false);
      if (submitted) return 'user_answered';
      await page.waitForTimeout(1000);
    }
  }

  const finalSubmitted = await detectNaukriApplicationSubmitted(page).catch(() => false);
  if (finalSubmitted) return 'user_answered';

  return 'no_response';
}

export async function handleNaukriChatbot(opts: {
  page: Page;
  profile: CandidateProfile;
  resumePdfBytes: Uint8Array;
  resumeFilename: string;
  companyName?: string;
  jobTitle?: string;
  autoSubmit?: boolean;
}): Promise<PlatformResult> {
  const { page, profile, resumePdfBytes, resumeFilename, companyName, jobTitle, autoSubmit } = opts;
  const filledFields: string[] = [];
  let stepCount = 0;
  let prevQuestion = '';
  let sameQuestionCount = 0;

  for (let step = 0; step < MAX_CHATBOT_STEPS; step++) {
    stepCount = step + 1;

    // Safety: Cancellation check
    if (isApplyCancelled()) {
      console.log('[naukri] Auto-apply session cancelled by user. Halting chatbot loop.');
      return { status: 'cancelled', filledFields, resumeAttached: false, stepCount, error: 'Auto-apply stopped by user' };
    }

    // Safety: CAPTCHA check
    if (await detectNaukriCaptcha(page)) {
      return { status: 'captcha', filledFields, resumeAttached: false, stepCount, error: 'CAPTCHA detected. Please solve it manually.' };
    }

    // Safety: Login check
    if (await detectNaukriLoginRequired(page)) {
      return { status: 'login_required', filledFields, resumeAttached: false, stepCount, error: 'Naukri login required.' };
    }

    // Check if application is ALREADY submitted
    const isSubmitted = await detectNaukriApplicationSubmitted(page);
    if (isSubmitted) {
      await closeNaukriChatbotDrawer(page);
      return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
    }

    // Check if chatbot drawer is still open
    const drawerOpen = await isChatbotOpen(page);
    if (!drawerOpen) {
      await closeNaukriChatbotDrawer(page);
      await page.waitForTimeout(800);
      if (await detectNaukriApplicationSubmitted(page)) {
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      break;
    }

    const questionText = await getCurrentQuestionText(page);

    // Stuck loop protection: if the bot is asking the identical question 2+ times
    if (questionText && questionText === prevQuestion) {
      sameQuestionCount++;
      if (sameQuestionCount >= 4) {
        console.warn(`[naukri] Bot repeating question "${questionText}" 4+ times without advancing. Pausing for user manual review.`);
        await focusApplyPage(page, true);
        return {
          status: 'stopped_for_review',
          readyForSubmit: false,
          filledFields,
          resumeAttached: true,
          stepCount,
          error: `Bot repeated question "${questionText.slice(0, 50)}" 4 times without advancing.`,
        };
      }

      // If repeating 3+ times, attempt skip if available
      if (sameQuestionCount >= 3) {
        console.warn(`[naukri] Bot repeating question: "${questionText}" (attempt ${sameQuestionCount}). Attempting skip.`);
        const skipped = await clickChatbotSkip(page);
        if (skipped) {
          const submitted = await waitForNaukriSubmission(page, 3000);
          if (submitted) {
            await closeNaukriChatbotDrawer(page);
            return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
          }
          continue;
        }
      }

      if (sameQuestionCount >= 2) {
        console.warn(`[naukri] Bot repeating question: "${questionText}". Retrying answer typing with normalized fallback.`);
        // Resolve the proper contextual answer (never hardcode 'NA' for numbers/experience/yes-no/ctc)
        let fallbackAns = resolveChatbotTextAnswer(questionText, profile, companyName);
        const isYearsOrExp = /(?:how many\s+)?(?:years|months|days)(?:\s+of)?(?:\s+experience|\s+exp)?\b|experience in\b|years in\b|\byoe\b/i.test(questionText);
        const isCtc = /(?:current|present|expected)?\s*(?:ctc|salary|compensation|package)|salary expectation/i.test(questionText);
        if (isCtc) {
          const match = (fallbackAns || '').match(/\d+(?:\.\d+)?/);
          if (match) {
            const val = parseFloat(match[0]);
            fallbackAns = val > 200 ? Number((val / 100000).toFixed(2)).toString() : Number(val.toFixed(2)).toString();
          } else {
            const inr = (profile.currentCtcInr as number | undefined) ?? (profile.current_ctc_inr as number | undefined) ?? 500000;
            fallbackAns = Number((inr / 100000).toFixed(2)).toString();
          }
        } else if (isYearsOrExp) {
          fallbackAns = (fallbackAns || '').replace(/\D/g, '') || '3';
        } else if (!fallbackAns) {
          const isYesNo =
            /^(?:are\s+you|do\s+you|can\s+you|will\s+you|have\s+you|is\s+there|would\s+you|did\s+you)\b/i.test(questionText.trim()) ||
            (/\?\s*$/i.test(questionText.trim()) && /(?:yes\s*\/\s*no|y\s*\/\s*n)/i.test(questionText));
          if (isYesNo) {
            fallbackAns = /ex[- ]employee|former employee|criminal|convict|backlog|bond|disciplinary/i.test(questionText) ? 'No' : 'Yes';
          } else {
            fallbackAns = 'NA';
          }
        }
        await typeIntoChatbotInput(page, fallbackAns);

        if (!autoSubmit) {
          console.log(`[naukri] Answer typed on repeated question. Waiting for user action before Save.`);
          await focusApplyPage(page, true);
          return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
        }

        if (page.keyboard) {
          await page.keyboard.press('Enter').catch(() => {});
          await page.waitForTimeout(300);
        }
        await clickChatbotSave(page);
        const submitted = await waitForNaukriSubmission(page, 3000);
        if (submitted) {
          await closeNaukriChatbotDrawer(page);
          return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
        }
        await page.waitForTimeout(800);
        continue;
      }
    } else {
      prevQuestion = questionText;
      sameQuestionCount = 0;
    }

    const qType = await detectQuestionType(page, questionText);

    if (qType === 'file_upload') {
      const uploaded = await uploadNaukriResume(page, resumeFilename, resumePdfBytes);
      if (uploaded) filledFields.push('Resume');

      if (!uploaded) {
        console.warn('[naukri] Resume upload failed in chatbot. Stopping for manual entry.');
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: false, filledFields, resumeAttached: false, stepCount };
      }

      if (!autoSubmit) {
        console.log('[naukri] Resume uploaded in manual mode — stopping without clicking Save.');
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 2500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'skill_chips') {
      const answered = await answerSkillChipsQuestion(page, profile);
      if (answered) filledFields.push('Key Skills');

      if (!answered) {
        console.warn(`[naukri] Autofill could not select skill chips for "${questionText}". Stopping for manual entry.`);
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: false, filledFields, resumeAttached: true, stepCount };
      }

      if (!autoSubmit) {
        console.log('[naukri] Skill chips selected in manual mode — stopping without clicking Save.');
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 2500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'custom_dropdown') {
      const answered = await answerCustomDropdownQuestion(page, questionText, profile);
      if (answered) filledFields.push(questionText.slice(0, 50));

      if (!answered) {
        console.warn(`[naukri] Autofill could not answer custom dropdown for "${questionText}". Stopping for manual entry.`);
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: false, filledFields, resumeAttached: true, stepCount };
      }

      if (!autoSubmit) {
        console.log('[naukri] Custom dropdown selected in manual mode — stopping without clicking Save.');
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 2500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'radio') {
      const options = await getRadioOptions(page);
      const answered = await answerRadioQuestion(page, questionText, profile, options);
      if (answered) filledFields.push(questionText.slice(0, 50));

      if (!answered) {
        console.warn(`[naukri] Autofill could not answer radio question: "${questionText}". Watching cursor/keyboard for user entry...`);
        const outcome = await waitForUserIntervention(page, questionText, 20000);
        if (outcome === 'user_answered') {
          await closeNaukriChatbotDrawer(page);
          return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
        }
        return {
          status: 'skipped',
          filledFields,
          resumeAttached: true,
          stepCount,
          error: `Autofill could not answer: "${questionText.slice(0, 50)}". Skipped and kept on Dashboard.`,
        };
      }

      if (!autoSubmit) {
        console.log('[naukri] Radio option selected in manual mode — stopping without clicking Save.');
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 2500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'checkbox') {
      const answered = await answerCheckboxQuestion(page, questionText, profile);
      if (answered) filledFields.push(questionText.slice(0, 50));

      if (!answered) {
        console.warn(`[naukri] Autofill could not answer checkbox question: "${questionText}". Watching cursor/keyboard for user entry...`);
        const outcome = await waitForUserIntervention(page, questionText, 20000);
        if (outcome === 'user_answered') {
          await closeNaukriChatbotDrawer(page);
          return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
        }
        return {
          status: 'skipped',
          filledFields,
          resumeAttached: true,
          stepCount,
          error: `Autofill could not answer: "${questionText.slice(0, 50)}". Skipped and kept on Dashboard.`,
        };
      }

      if (!autoSubmit) {
        console.log('[naukri] Checkbox options selected in manual mode — stopping without clicking Save.');
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 2500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'text') {
      let answered = await answerTextQuestion(page, questionText, profile, companyName, jobTitle);
      if (answered) filledFields.push(questionText.slice(0, 50));

      if (autoSubmit) {
        await clickChatbotSave(page);
        await page.waitForTimeout(600);

        // Check for inline DOM validation error
        const constraints = await extractNaukriDOMConstraints(page);
        if (constraints.errorMessage) {
          console.warn(`[naukri] Inline form validation error detected: "${constraints.errorMessage}". Retrying with Gemini...`);
          answered = await answerTextQuestion(
            page,
            questionText,
            profile,
            companyName,
            jobTitle,
            constraints.errorMessage
          );
          if (answered) {
            await clickChatbotSave(page);
            await page.waitForTimeout(600);
          }
        }
      }

      if (!answered) {
        console.warn(`[naukri] Autofill could not answer text question: "${questionText}". Watching cursor/keyboard for user entry...`);
        const outcome = await waitForUserIntervention(page, questionText, 20000);
        if (outcome === 'user_answered') {
          await closeNaukriChatbotDrawer(page);
          return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
        }
        return {
          status: 'skipped',
          filledFields,
          resumeAttached: true,
          stepCount,
          error: `Autofill could not answer: "${questionText.slice(0, 50)}". Skipped and kept on Dashboard.`,
        };
      }

      if (!autoSubmit) {
        console.log('[naukri] Text answer entered in manual mode — stopping without clicking Save.');
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      const submitted = await waitForNaukriSubmission(page, 2500);
      if (submitted) {
        console.log('[naukri] Application submitted successfully detected after answering text question!');
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'select') {
      let answered = false;
      try {
        const select = page.locator(`${CHATBOT_DRAWER} select`).first();
        const options = await select.locator('option').allTextContents();
        const goodOption = options.find((o) => /yes|full.?time|permanent/i.test(o)) || options.find((o) => o.trim() && o.trim() !== 'Select');
        if (goodOption) {
          await select.selectOption({ label: goodOption.trim() }).catch(() => {});
          filledFields.push(questionText.slice(0, 50));
          answered = true;
        }
      } catch {}

      if (!answered) {
        console.warn(`[naukri] Autofill could not select dropdown option for "${questionText}". Watching cursor/keyboard for user entry...`);
        const outcome = await waitForUserIntervention(page, questionText, 20000);
        if (outcome === 'user_answered') {
          await closeNaukriChatbotDrawer(page);
          return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
        }
        return {
          status: 'skipped',
          filledFields,
          resumeAttached: true,
          stepCount,
          error: `Autofill could not answer: "${questionText.slice(0, 50)}". Skipped and kept on Dashboard.`,
        };
      }

      if (!autoSubmit) {
        console.log('[naukri] Select option chosen in manual mode — stopping without clicking Save.');
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 2500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    // Unknown question type — inspect DOM for visible inputs or option buttons before skipping/saving
    const visibleInput = page.locator(CHATBOT_TEXT_INPUT).first();
    if ((await visibleInput.count()) > 0 && (await visibleInput.isVisible().catch(() => false))) {
      console.log('[naukri] Unknown question type matched visible text input — treating as text question');
      const answered = await answerTextQuestion(page, questionText, profile, companyName, jobTitle);
      if (answered) {
        filledFields.push(questionText.slice(0, 50) || 'Text Question');
        if (autoSubmit) {
          await clickChatbotSave(page);
          const submitted = await waitForNaukriSubmission(page, 2500);
          if (submitted) {
            await closeNaukriChatbotDrawer(page);
            return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
          }
        }
        continue;
      }
    }

    const visibleRadio = page.locator(CHATBOT_RADIO).first();
    if ((await visibleRadio.count()) > 0 && (await visibleRadio.isVisible().catch(() => false))) {
      console.log('[naukri] Unknown question type matched visible radio options — treating as radio question');
      const options = await getRadioOptions(page);
      const answered = await answerRadioQuestion(page, questionText, profile, options);
      if (answered) {
        filledFields.push(questionText.slice(0, 50) || 'Radio Question');
        if (autoSubmit) {
          await clickChatbotSave(page);
          const submitted = await waitForNaukriSubmission(page, 2500);
          if (submitted) {
            await closeNaukriChatbotDrawer(page);
            return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
          }
        }
        continue;
      }
    }

    const skipped = await clickChatbotSkip(page);
    if (!skipped) {
      if (!autoSubmit) {
        await focusApplyPage(page, true);
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }
      await clickChatbotSave(page);
    }
    const submitted = await waitForNaukriSubmission(page, 2500);
    if (submitted) {
      await closeNaukriChatbotDrawer(page);
      return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
    }
  }

  // After all chatbot questions are answered, check if application was submitted
  const finalSubmitted = await detectNaukriApplicationSubmitted(page);
  if (finalSubmitted) {
    await closeNaukriChatbotDrawer(page);
    return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
  }

  // Bring Chrome window to front at the end of autofill so user can do final Save/Submit
  await focusApplyPage(page, true);

  return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
}

/**
 * Update the candidate's active resume on their Naukri profile page (https://www.naukri.com/mnjuser/profile).
 *
 * Background:
 * On Naukri, 1-click direct apply listings do not provide an in-page resume upload field.
 * Instead, clicking "Apply" automatically submits whichever resume is currently active
 * on the candidate's Naukri profile. By updating the profile resume immediately prior
 * to applying, the 1-click apply submits the candidate's tailored Overleaf LaTeX resume. Naukri captures an
 * immutable snapshot of the CV at submission time, so previous applications remain unchanged.
 */
export async function updateNaukriProfileResume(
  page: Page,
  resumeFilename: string,
  resumePdfBytes: Uint8Array,
): Promise<boolean> {
  const file = {
    name: resumeFilename,
    mimeType: 'application/pdf',
    buffer: Buffer.from(resumePdfBytes),
  };

  try {
    // Navigate to Naukri candidate profile
    await page.goto('https://www.naukri.com/mnjuser/profile', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);

    // If redirected or login prompt appears, abort
    if (await detectNaukriLoginRequired(page)) {
      console.warn('[naukri] Profile update skipped: login required.');
      return false;
    }

    // Common file input selectors on Naukri profile
    const PROFILE_FILE_INPUT_SELECTORS = [
      'input#attachCV',
      'input[type="file"]#attachCV',
      'input[type="file"][id*="attachCV" i]',
      'input[type="file"][id*="lazyAttachCV" i]',
      'input#lazyAttachCV',
      'input[type="file"][name*="attachCV" i]',
    ];

    let fileInputFound = false;
    for (const sel of PROFILE_FILE_INPUT_SELECTORS) {
      try {
        const input = page.locator(sel).first();
        if ((await input.count()) > 0) {
          await input.setInputFiles(file);
          fileInputFound = true;
          break;
        }
      } catch {
        // try next selector
      }
    }

    if (!fileInputFound) {
      // Look for any file input inside a resume-related section
      try {
        const resumeSection = page.locator('div, section, .widgetHead').filter({ hasText: /resume|\bcv\b/i }).first();
        if ((await resumeSection.count()) > 0) {
          const input = resumeSection.locator('input[type="file"]').first();
          if ((await input.count()) > 0) {
            await input.setInputFiles(file);
            fileInputFound = true;
          }
        }
      } catch {
        // continue
      }
    }

    if (!fileInputFound) {
      // Fallback: Look for "Update resume" or "Upload resume" button and handle filechooser event
      const updateButtons = [
        'a:has-text("Update resume")',
        'button:has-text("Update resume")',
        'span:has-text("Update resume")',
        '.update-resume',
        'a:has-text("Upload resume")',
        'button:has-text("Upload resume")',
      ];
      for (const sel of updateButtons) {
        try {
          const btn = page.locator(sel).first();
          if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
            const [fileChooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
              btn.click().catch(() => {}),
            ]);
            if (fileChooser) {
              await fileChooser.setFiles(file);
              fileInputFound = true;
              break;
            }
          }
        } catch {
          // try next
        }
      }
    }

    if (!fileInputFound) {
      console.warn('[naukri] Could not locate resume file input on profile page.');
      return false;
    }

    // Wait for the upload to process and confirm
    try {
      await page.waitForSelector('.upload-success, div.msg, div:has-text("successfully uploaded"), div:has-text("Uploaded on")', {
        timeout: 8000,
      }).catch(() => {});
    } catch {
      // ignore
    }

    await page.waitForTimeout(2000);
    return true;
  } catch (err) {
    console.warn('[naukri] Profile resume upload failed:', (err as Error).message);
    return false;
  }
}

/**
 * Pre-launch the Chrome window and navigate to the Naukri job URL immediately.
 * Intended to be called in parallel with prepareSubmission (LLM + PDF generation)
 * so the user sees the browser open right away — not after all background work finishes.
 *
 * Returns { ctx, page } on success, or null if launch fails (naukriApply falls back
 * to its own inline launch in that case).
 */
export async function preLaunchNaukriBrowser(jobUrl: string): Promise<{
  ctx: BrowserContext;
  page: Page;
} | null> {
  const profileDir = resolveNaukriProfileDir();
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
    // Bring window to front only for the first job apply
    await focusApplyPage(page, false);
    // Navigate to the job URL — this finishes in 2-5s, well before resume generation
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await focusApplyPage(page, false);
    console.log('[naukri] Pre-launched browser and navigated to:', jobUrl);
    return { ctx, page };
  } catch (err) {
    console.warn('[naukri] preLaunchNaukriBrowser failed — naukriApply will launch inline:', (err as Error).message);
    return null;
  }
}

/**
 * Full Naukri apply flow: launch browser, navigate to job URL,
 * detect Easy Apply, update profile resume if tailored PDF available,
 * click apply, handle chatbot, and stop for review.
 */
export async function naukriApply(opts: {
  jobUrl: string;
  profile: CandidateProfile;
  resumePdfBytes: Uint8Array;
  resumeFilename: string;
  updateProfileResume?: boolean;
  companyName?: string;
  jobTitle?: string;
  autoSubmit?: boolean;
  /** Pre-launched browser context from preLaunchNaukriBrowser. Skips re-launching Chrome. */
  prelaunchedContext?: { ctx: BrowserContext; page: Page } | null;
}): Promise<PlatformResult> {
  const { jobUrl, profile, resumePdfBytes, resumeFilename, companyName, jobTitle, autoSubmit } = opts;

  const profileDir = resolveNaukriProfileDir();
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  if (isApplyCancelled()) {
    return { status: 'cancelled', filledFields: [], resumeAttached: false, stepCount: 0, error: 'Auto-apply stopped by user' };
  }

  let ctx: BrowserContext | null = null;
  try {
    let page: Page;

    if (opts.prelaunchedContext) {
      // ── Fast path: browser was launched in parallel with resume generation ──
      // The Chrome window was already shown to the user while the tailored PDF
      // was being generated. Just confirm page is loaded and bring it to front.
      ctx = opts.prelaunchedContext.ctx;
      page = opts.prelaunchedContext.page;
      // Ensure navigation completed (it was started concurrently)
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });
      } catch { /* already loaded or timed out — continue */ }
      // Safety re-navigate if the page didn't land on Naukri
      const prelaunchUrl = page.url();
      if (prelaunchUrl === 'about:blank' || !prelaunchUrl.includes('naukri')) {
        await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
      await focusApplyPage(page, false);
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await focusApplyPage(page, false);
    }

    // Brief pause so user can visually confirm the job page before automation begins
    await page.waitForTimeout(1200);

    // ── STEP 1: Fast Status Assessment Loop with 10s Time Limit ──
    const BUTTON_WAIT_TIMEOUT_MS = 10_000;
    const startWait = Date.now();
    let directApplyBtn: Locator | null = null;
    let isExpired = false;
    let isCompanySite = false;
    let isAlreadyApplied = false;

    console.log(`[naukri] Checking job page status (timeout limit: ${BUTTON_WAIT_TIMEOUT_MS / 1000}s)...`);

    while (Date.now() - startWait < BUTTON_WAIT_TIMEOUT_MS) {
      if (isApplyCancelled()) {
        return { status: 'cancelled', filledFields: [], resumeAttached: false, stepCount: 0, error: 'Auto-apply stopped by user' };
      }

      // Check 1: Is the job expired / closed?
      if (await detectNaukriExpired(page)) {
        console.log('[naukri] Job detected as expired / closed');
        isExpired = true;
        break;
      }

      // Check 2: Does it require applying on company site (external)?
      if (await detectNaukriCompanySite(page)) {
        console.log('[naukri] Job detected as external apply (company site)');
        isCompanySite = true;
        break;
      }

      // Check 3: Is it already applied?
      if (await detectNaukriApplicationSubmitted(page)) {
        console.log('[naukri] Job already applied');
        isAlreadyApplied = true;
        break;
      }

      // Check 4: Direct Apply button found?
      const btn = await findNaukriDirectApplyButton(page);
      if (btn) {
        console.log('[naukri] Direct Apply button confirmed visible');
        directApplyBtn = btn;
        break;
      }

      // Check 5: CAPTCHA
      if (await detectNaukriCaptcha(page)) {
        await focusApplyPage(page, true);
        ctx = null;
        return { status: 'captcha', filledFields: [], resumeAttached: false, stepCount: 0, error: 'CAPTCHA detected on the job page. Please solve it manually.' };
      }

      // Check 6: Login required
      if (await detectNaukriLoginRequired(page)) {
        break;
      }

      await page.waitForTimeout(400);
    }

    // Handle Expired Job immediately: don't waste time updating profile resume!
    if (isExpired) {
      if (autoSubmit && ctx) {
        try {
          const p = ctx.pages()[0];
          if (p && !p.isClosed()) await p.goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
        } catch {}
      }
      ctx = null;
      return {
        status: 'expired',
        filledFields: [],
        resumeAttached: false,
        stepCount: 0,
        error: 'Job has expired (no longer accepting applications).',
      };
    }

    // Handle Company Site immediately: don't waste time updating profile resume!
    if (isCompanySite) {
      if (autoSubmit && ctx) {
        try {
          const p = ctx.pages()[0];
          if (p && !p.isClosed()) await p.goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
        } catch {}
      }
      ctx = null;
      return {
        status: 'external_apply',
        filledFields: [],
        resumeAttached: false,
        stepCount: 0,
        error: 'This job requires applying on the company website (not Naukri direct apply).',
      };
    }

    // Handle Already Applied
    if (isAlreadyApplied) {
      if (autoSubmit && ctx) {
        try {
          const p = ctx.pages()[0];
          if (p && !p.isClosed()) await p.goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
        } catch {}
      }
      ctx = null;
      return {
        status: 'submitted',
        filledFields: ['Already Applied on Naukri'],
        resumeAttached: true,
        stepCount: 1,
      };
    }

    // Safety: login check
    if (await detectNaukriLoginRequired(page)) {
      await focusApplyPage(page, true);

      // Wait for user to complete login (up to 2 minutes)
      const loginCompleted = await waitForNaukriLogin(page, 120_000);
      if (!loginCompleted) {
        ctx = null; // Leave browser open for user login
        return {
          status: 'login_required',
          filledFields: [],
          resumeAttached: false,
          stepCount: 0,
          error: 'Naukri login required. Please log into your Naukri account in the Chrome window.',
        };
      }

      // Login completed - wait for page to stabilize again
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      directApplyBtn = await findNaukriDirectApplyButton(page);
    }

    // Safety: CAPTCHA check
    if (await detectNaukriCaptcha(page)) {
      await focusApplyPage(page, true);
      ctx = null;
      return { status: 'captcha', filledFields: [], resumeAttached: false, stepCount: 0, error: 'CAPTCHA detected on the job page. Please solve it manually.' };
    }

    // If still no direct apply button found after timeout limit (10s):
    if (!directApplyBtn) {
      // Final re-checks in case page finished rendering during login wait
      if (await detectNaukriExpired(page)) {
        ctx = null;
        return { status: 'expired', filledFields: [], resumeAttached: false, stepCount: 0, error: 'Job has expired (no longer accepting applications).' };
      }
      if (await detectNaukriCompanySite(page)) {
        ctx = null;
        return { status: 'external_apply', filledFields: [], resumeAttached: false, stepCount: 0, error: 'This job requires applying on the company website (not Naukri direct apply).' };
      }
      console.warn(`[naukri] No apply button found within ${BUTTON_WAIT_TIMEOUT_MS / 1000}s time limit.`);
      if (autoSubmit && ctx) {
        try {
          const p = ctx.pages()[0];
          if (p && !p.isClosed()) await p.goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
        } catch {}
      }
      ctx = null;
      return {
        status: 'timeout_skipped',
        filledFields: [],
        resumeAttached: false,
        stepCount: 0,
        error: `No Apply button found within time limit (${BUTTON_WAIT_TIMEOUT_MS / 1000}s). Skipping to next job...`,
      };
    }

    // ── STEP 2: Pre-apply Profile Resume Update (Only for valid direct-apply jobs!) ──
    let profileResumeUpdated = false;
    const shouldUpdateProfile = opts.updateProfileResume ?? getApplyConfig().updateNaukriProfileResume ?? true;
    if (shouldUpdateProfile && resumePdfBytes && resumePdfBytes.length > 0) {
      try {
        const profilePage = await ctx.newPage();
        profileResumeUpdated = await updateNaukriProfileResume(profilePage, resumeFilename, resumePdfBytes);
        await profilePage.close().catch(() => {});
        if (shouldBringWindowToFront(false)) { try { await page.bringToFront(); } catch {} }
      } catch (err) {
        console.warn('[naukri] Pre-apply profile resume upload warning:', err);
      }
    }

    // ── STEP 3: Click the Verified Direct Apply Button ──
    let applyClicked = false;
    try {
      await directApplyBtn.scrollIntoViewIfNeeded().catch(() => {});
      await directApplyBtn.evaluate((el) => {
        el.style.outline = '3px solid #ef4444';
        el.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.9)';
      }).catch(() => {});
    } catch {}
    await focusApplyPage(page, false);
    await page.waitForTimeout(600);

    try {
      await directApplyBtn.click({ timeout: 5000 });
      applyClicked = true;
    } catch (err) {
      console.warn('[naukri] Error clicking direct Apply button:', (err as Error).message);
      ctx = null;
      return { status: 'error', filledFields: [], resumeAttached: false, stepCount: 0, error: 'Could not click the Apply button.' };
    }

    // Wait for chatbot or form to appear
    await page.waitForTimeout(2000);

    // Handle the chatbot flow if present
    const chatOpen = await isChatbotOpen(page);
    if (chatOpen) {
      const result = await handleNaukriChatbot({
        page,
        profile,
        resumePdfBytes,
        resumeFilename,
        companyName,
        jobTitle,
        autoSubmit,
      });

      if (profileResumeUpdated && !result.resumeAttached) {
        result.resumeAttached = true;
        result.filledFields.push('Resume (Profile Updated)');
      }

      // If application was confirmed submitted, dismiss drawer; otherwise keep open for user review
      if (result.status === 'submitted') {
        await closeNaukriChatbotDrawer(page);
        if (autoSubmit) {
          try {
            if (!page.isClosed()) await page.goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
          } catch {}
        }
      } else if (result.status === 'stopped_for_review') {
        result.readyForSubmit = true;
      }

      if (result.status === 'cancelled') {
        if (ctx) await ctx.close().catch(() => {});
        ctx = null;
        return result;
      }

      if (!autoSubmit || result.status === 'stopped_for_review') {
        // Bring browser to front for confirmation / review
        await focusApplyPage(page, true);
      }

      ctx = null; // Keep browser open
      return result;
    }

    // No chatbot — standard form apply (1-click direct apply)
    await page.waitForTimeout(2500);
    const isSubmitted = await detectNaukriApplicationSubmitted(page);
    if (isSubmitted) {
      await closeNaukriChatbotDrawer(page);
    }

    if (autoSubmit && (isSubmitted || applyClicked)) {
      try {
        if (!page.isClosed()) await page.goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
      } catch {}
    } else if (!autoSubmit || (!isSubmitted && !applyClicked)) {
      await focusApplyPage(page, true);
    }
    ctx = null; // Keep browser open

    const filledFields: string[] = [];
    if (profileResumeUpdated) {
      filledFields.push('Resume (Profile Updated)');
    }

    return {
      status: isSubmitted || applyClicked ? 'submitted' : 'stopped_for_review',
      filledFields,
      resumeAttached: profileResumeUpdated,
      stepCount: 1,
    };
  } catch (err) {
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
    // Only close context if explicitly cancelled; keep browser open for user review in all normal flows
    if (ctx && isApplyCancelled()) {
      await ctx.close().catch(() => {});
    }
  }
}
