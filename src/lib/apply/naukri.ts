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

import { type BrowserContext, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import type { CandidateProfile, PlatformResult } from './platform';
import { launchApplyBrowser, bringWindowToFront, AUTO_APPLY_SUCCESS_PAGE, isApplyCancelled } from './launcher';
import { getApplyConfig, answerScreeningQuestion, normalizeCityName, matchCityResidenceQuestion } from './questions';

export { normalizeCityName, matchCityResidenceQuestion };

const BROWSER_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

// ----- Naukri-specific selectors ---------------------------------------------

const APPLY_BUTTON_SELECTORS = [
  'button#apply-button',
  'button.apply-button',
  'button:has-text("Apply")',
  'button:has-text("Login to apply")',
  'button:has-text("Continue with Google")',
  'button:has-text("Continue with google")',
  'a:has-text("Continue with Google")',
  'a:has-text("Continue with google")',
  '[class*="apply-button"]',
  '[class*="applyBtn"]',
];

const COMPANY_SITE_SELECTORS = [
  'button#company-site-button',
  'a#company-site-button',
];

const CHATBOT_DRAWER = ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"])';

const CHATBOT_MESSAGE = 'li.botItem, li[class*="botItem"], div.botItem, div[class*="botItem"], div.msg_container.bot, div.botMsg';

const CHATBOT_TEXT_INPUT = [
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) div[contenteditable="true"].textArea',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) div[contenteditable="true"]',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) input[type="text"].chatbot_Input',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) input[type="text"]',
  ':is(div.chatbot_DrawerContentWrapper, div[class*="chatbot"]) textarea',
  'div[contenteditable="true"].textArea',
  'div.textAreaWrapper [contenteditable="true"]',
  'div[contenteditable="true"]',
  'input[type="text"].chatbot_Input',
  'textarea',
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

const CHATBOT_RADIO = `${CHATBOT_DRAWER} label.ssrc__label, ${CHATBOT_DRAWER} .ssrc__radio-btn-container, ${CHATBOT_DRAWER} .singleselect-radiobutton, label.ssrc__label, .singleselect-radiobutton`;

const CHATBOT_CHECKBOX = `${CHATBOT_DRAWER} div.multiselectcheckboxes, ${CHATBOT_DRAWER} .mcc__checkbox, ${CHATBOT_DRAWER} label.mcc__label, div.multiselectcheckboxes, .mcc__checkbox, label.mcc__label`;

const CHATBOT_FILE_UPLOAD = `${CHATBOT_DRAWER} input.chatbot_Uploader[type="file"], ${CHATBOT_DRAWER} input[type="file"][class*="chatbot"], input.chatbot_Uploader[type="file"]`;

const CHATBOT_SAVE_BUTTON = [
  `${CHATBOT_DRAWER} div.send:not(.disabled) div.sendMsg`,
  `${CHATBOT_DRAWER} div.send:not(.disabled)`,
  `${CHATBOT_DRAWER} button:has-text("Save")`,
  'div.sendMsg',
  'div[class*="sendMsg"]',
  'div.send:not(.disabled)',
  'button:has-text("Save")',
  'button:has-text("Submit")',
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

/**
 * Detect whether Naukri's direct-apply (Easy Apply) button is present.
 * Returns false if the company-site button is visible (external apply only).
 */
export async function detectNaukriEasyApply(page: Page): Promise<boolean> {
  // If the "Apply on company site" button is visible, it's NOT Easy Apply
  for (const sel of COMPANY_SITE_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        return false;
      }
    } catch {
      // continue
    }
  }

  // Check for the direct apply button
  for (const sel of APPLY_BUTTON_SELECTORS) {
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
  // Naukri shows a login / continue with google button when not authenticated
  try {
    const loginBtn = page.locator(
      'button#login-apply-button, button#continue-with-google-button, [class*="continue-with-google"], .login-to-apply, a:has-text("Login"), button:has-text("Login")'
    ).first();
    if ((await loginBtn.count()) > 0 && (await loginBtn.isVisible().catch(() => false))) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

// ----- Chatbot interaction ---------------------------------------------------

/**
 * Detect whether the chatbot drawer is open and has an active question.
 */
async function isChatbotOpen(page: Page): Promise<boolean> {
  try {
    const drawer = page.locator(CHATBOT_DRAWER).first();
    if ((await drawer.count()) === 0) return false;
    const isVisible = await drawer.isVisible().catch(() => false);
    if (!isVisible) return false;

    // If application is already confirmed submitted, chatbot has completed
    if (await detectNaukriApplicationSubmitted(page)) return false;

    // Check for interactive question elements inside the chatbot
    const hasRadio = (await page.locator(CHATBOT_RADIO).first().count() > 0) && (await page.locator(CHATBOT_RADIO).first().isVisible().catch(() => false));
    const hasCheckbox = (await page.locator(CHATBOT_CHECKBOX).first().count() > 0) && (await page.locator(CHATBOT_CHECKBOX).first().isVisible().catch(() => false));
    const textInput = page.locator(CHATBOT_TEXT_INPUT).first();
    const hasInput = (await textInput.count() > 0) && (await textInput.isVisible().catch(() => false));
    const hasSelect = (await page.locator(`${CHATBOT_DRAWER} select`).first().count() > 0);
    const hasFile = (await page.locator(CHATBOT_FILE_UPLOAD).first().count() > 0);

    return hasRadio || hasCheckbox || hasInput || hasSelect || hasFile;
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
async function detectQuestionType(page: Page, questionText: string): Promise<'radio' | 'checkbox' | 'text' | 'file_upload' | 'select' | 'unknown'> {
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

  // 3. Native select
  const selects = page.locator(`${CHATBOT_DRAWER} select`).first();
  if ((await selects.count()) > 0 && (await selects.isVisible().catch(() => false))) {
    return 'select';
  }

  // 4. File upload (only if question specifically prompts for resume/CV/upload)
  if (/resume|cv|upload|attach/i.test(questionText)) {
    const fileInput = page.locator(CHATBOT_FILE_UPLOAD).first();
    if ((await fileInput.count()) > 0) {
      return 'file_upload';
    }
  }

  // 5. Visible text input (contenteditable div or input)
  const textInput = page.locator(CHATBOT_TEXT_INPUT).first();
  if ((await textInput.count()) > 0 && (await textInput.isVisible().catch(() => false))) {
    return 'text';
  }

  return 'unknown';
}

/**
 * Read the available options for a radio button question.
 */
async function getRadioOptions(page: Page): Promise<string[]> {
  try {
    const labels = page.locator(`${CHATBOT_DRAWER} label.ssrc__label`);
    const count = await labels.count();
    const options: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = (await labels.nth(i).innerText().catch(() => '')).trim();
      if (text && !text.includes('\n') && !options.includes(text)) {
        options.push(text);
      }
    }
    return options;
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
async function answerRadioQuestion(page: Page, questionText: string, profile: CandidateProfile, options: string[]): Promise<boolean> {
  const lowerQuestion = questionText.toLowerCase();

  let targetIndex = -1;
  let targetAnswer: string | null = null;

  // Ex-employee / previous employment with this company
  if (/ex[- ](employee|emp|infosys|tcs|wipro|cognizant)|former employee|previous employee|past employee|previously worked/i.test(questionText)) {
    targetAnswer = 'No';
    targetIndex = options.findIndex((o) => o.toLowerCase() === 'no');
    if (targetIndex < 0) {
      targetIndex = options.findIndex((o) => /na|none|never/i.test(o));
    }
  }

  // City residence verification (e.g. "Are you residing curretly in Hydrabad ?")
  else if (matchCityResidenceQuestion(questionText, profile.location)) {
    const cityCheck = matchCityResidenceQuestion(questionText, profile.location)!;
    targetAnswer = cityCheck.answer;
    targetIndex = options.findIndex((o) => o.trim().toLowerCase() === cityCheck.answer.toLowerCase());
  }

  // Work from office / hybrid / on-site
  else if (/work from office|wfo|hybrid|on[- ]?site|in[- ]?office/i.test(questionText)) {
    targetAnswer = 'Yes';
    targetIndex = options.findIndex((o) => o.toLowerCase() === 'yes');
  }

  // Yes/No questions (willingness, relocate, ready to, comfortable, etc.)
  else if (/willing|able|can you|relocate|ready to|comfortable|okay with|open to|authorized/i.test(questionText)) {
    targetAnswer = 'Yes';
    targetIndex = options.findIndex((o) => o.toLowerCase() === 'yes');
  }

  // Experience / years questions (e.g. "How many years of experience do you have as ETL Developer ?")
  else if (/experience|years|yoe|how many.*year/i.test(questionText)) {
    const candidateYears = profile.yearsExperience || profile.yearsOfExperience || 4;
    targetIndex = matchExperienceOption(options, candidateYears);
    if (targetIndex >= 0 && targetIndex < options.length) {
      targetAnswer = options[targetIndex];
    }
  }

  // Notice period
  else if (/notice period|serving notice|lwd|last working/i.test(questionText)) {
    targetAnswer = '15 Days';
    targetIndex = options.findIndex((o) => o.includes('15') || o.toLowerCase().includes('immediate') || o.includes('< 15'));
    if (targetIndex < 0 && options.length > 0) {
      targetIndex = 0;
      targetAnswer = options[0];
    }
  }

  // Employment type
  else if (/employment type|full.?time|part.?time/i.test(questionText)) {
    targetAnswer = 'Full-time';
    targetIndex = options.findIndex((o) => o.toLowerCase().includes('full'));
    if (targetIndex < 0 && options.length > 0) {
      targetIndex = 0;
      targetAnswer = options[0];
    }
  }

  // Default: pick the first non-Skip option
  if (targetIndex < 0 && options.length > 0) {
    targetIndex = options.findIndex((o) => !/skip|decline|none of/i.test(o));
    if (targetIndex < 0) targetIndex = 0;
    targetAnswer = options[targetIndex];
  }

  if (targetIndex < 0) return false;

  // Click the label element for the chosen option (Naukri modern UI binds click to label.ssrc__label)
  try {
    const labels = page.locator(`${CHATBOT_DRAWER} label.ssrc__label`);
    const count = await labels.count();
    if (targetIndex < count) {
      await labels.nth(targetIndex).click({ timeout: 3000 });
      await page.waitForTimeout(500);
      return true;
    }
  } catch {}

  // Fallback: match by label text
  if (targetAnswer) {
    try {
      const byText = page.locator(
        `${CHATBOT_DRAWER} label.ssrc__label:has-text("${targetAnswer}"), ${CHATBOT_DRAWER} label:has-text("${targetAnswer}")`
      ).first();
      if ((await byText.count()) > 0) {
        await byText.click({ timeout: 3000 });
        await page.waitForTimeout(500);
        return true;
      }
    } catch {}
  }

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
  if (/\b(github|portfolio|website)\b/i.test(q)) return profile.portfolioUrl || 'https://github.com/cshariharan01';

  // 4. Notice period / LWD / Joining time
  if (/notice period|serving notice|last working day|lwd|how soon can you join/i.test(q)) {
    const days = profile.noticePeriodDays ?? 30;
    if (/in days|\bdays\b/i.test(q)) return String(days);
    return `${days} Days`;
  }

  // 5. Current CTC / Compensation
  if (/current\s*(ctc|salary|compensation|fixed|take home|package)|present\s*(ctc|salary)/i.test(q)) {
    const inr = profile.currentCtcInr ?? 700000;
    if (/in lpa|\blpa\b|lakhs?/i.test(q)) {
      return `${(inr / 100000).toFixed(1)} LPA`;
    }
    if (/in inr|in ₹|rupees|digits|numbers?/i.test(q)) {
      return String(inr);
    }
    return `${(inr / 100000).toFixed(1)} LPA`;
  }

  // 6. Expected CTC / Compensation
  if (/expected\s*(ctc|salary|compensation|package)|salary expectation/i.test(q)) {
    const inr = profile.expectedCtcInr ?? 1200000;
    if (/in lpa|\blpa\b|lakhs?/i.test(q)) {
      return `${(inr / 100000).toFixed(1)} LPA`;
    }
    if (/in inr|in ₹|rupees|digits|numbers?/i.test(q)) {
      return String(inr);
    }
    return `${(inr / 100000).toFixed(1)} LPA`;
  }

  // 7. Experience / Years
  if (/(total|relevant|overall|years of)?\s*(experience|exp|yoe)\b/i.test(q)) {
    const yoe = profile.yearsOfExperience ?? profile.yearsExperience ?? 3;
    return String(yoe);
  }

  // 8. Location & Relocation
  if (/willing to relocate|ready to relocate|comfortable to relocate|open to relocate/i.test(q)) {
    return 'Yes';
  }
  const cityResidence = matchCityResidenceQuestion(q, profile.location);
  if (cityResidence) {
    return cityResidence.answer;
  }
  if (/current location|current city|where are you (currently )?(living|located|residing|based)/i.test(q)) {
    return profile.location || 'Madurai, India';
  }
  if (/preferred location|preferred city/i.test(q)) {
    return 'Bengaluru';
  }
  if (/work from office|wfo|hybrid|on[- ]?site|in[- ]?office/i.test(q)) {
    return 'Yes';
  }

  // 9. Current Company / Title
  if (/current (organization|company|employer)|present (organization|company|employer)/i.test(q)) {
    return profile.currentCompany || 'Solartis Technology';
  }
  if (/current (role|job title|designation)|present (role|job title|designation)/i.test(q)) {
    return profile.currentJobTitle || 'Data Engineer';
  }

  // 10. Education / College
  if (/highest (qualification|education|degree)|qualification|degree/i.test(q)) {
    return 'B.E. Computer Science and Engineering';
  }
  if (/pass(ing)? out year|graduation year|year of graduation/i.test(q)) {
    return '2022';
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
  try {
    const skipBtn = page.locator(CHATBOT_SKIP_BUTTON).first();
    if ((await skipBtn.count()) > 0 && (await skipBtn.isVisible().catch(() => false))) {
      console.log('[naukri] Clicking Skip button in chatbot');
      await skipBtn.click({ timeout: 3000 });
      await page.waitForTimeout(1500);
      return true;
    }
  } catch {
    // continue
  }
  return false;
}

/**
 * Type an answer into the Naukri chatbot input field (contenteditable div or input)
 * and trigger React input events so the Save button becomes active.
 */
async function typeIntoChatbotInput(page: Page, answer: string): Promise<boolean> {
  try {
    const textInput = page.locator(CHATBOT_TEXT_INPUT).first();
    if ((await textInput.count()) === 0) return false;

    await textInput.scrollIntoViewIfNeeded().catch(() => {});
    await textInput.click({ timeout: 3000 });
    await page.waitForTimeout(300);

    // Focus and clear existing text cleanly using keyboard for natural focus retention
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);

    // Type via keyboard for natural React event handling
    await page.keyboard.type(answer, { delay: 40 });
    await page.waitForTimeout(400);

    return true;
  } catch (err) {
    console.warn('[naukri] Error typing into chatbot input:', err);
    return false;
  }
}

/**
 * Answer a text input question by typing into the input field or skipping if optional.
 */
async function answerTextQuestion(
  page: Page,
  questionText: string,
  profile: CandidateProfile,
  companyName?: string,
  jobTitle?: string,
): Promise<boolean> {
  // 1. Resolve answer from deterministic heuristics
  let answer = resolveChatbotTextAnswer(questionText, profile, companyName);

  // 2. If no heuristic answer, try screening question answerer (which checks cache / LLM)
  if (!answer) {
    try {
      const llmResult = await answerScreeningQuestion(
        questionText,
        null,
        profile as unknown as Record<string, unknown>,
        { jobTitle: jobTitle || profile.currentJobTitle || 'Data Engineer', company: companyName || 'Company' },
      );
      if (llmResult.answer && llmResult.answer !== 'UNKNOWN') {
        answer = llmResult.answer;
      }
    } catch {
      // ignore
    }
  }

  // 3. Fallback: if prompt asks "if not, write NA" or "else NA"
  if (!answer && /(?:if not|else|otherwise|or)\s*,?\s*(?:write|enter|type)?\s*na\b/i.test(questionText)) {
    answer = 'NA';
  }

  // 4. If we still don't have an answer, try skipping if a skip button exists
  if (!answer) {
    const skipped = await clickChatbotSkip(page);
    if (skipped) return true;

    // If it's a Yes/No question, never blindly fallback to 'NA'
    const isYesNo =
      /^(?:are\s+you|do\s+you|can\s+you|will\s+you|have\s+you|is\s+there|would\s+you|did\s+you)\b/i.test(questionText.trim()) ||
      (/\?\s*$/i.test(questionText.trim()) && /(?:yes\s*\/\s*no|y\s*\/\s*n)/i.test(questionText));

    if (isYesNo) {
      // Negative question patterns: ex-employee, criminal, bond, gaps, active backlog
      if (/ex[- ]employee|former employee|criminal|convict|backlog|bond|disciplinary/i.test(questionText)) {
        answer = 'No';
      } else {
        // For willingness, night shifts, shifts, travel, join, general positive questions -> 'Yes'
        answer = 'Yes';
      }
    } else {
      // Last resort for required unhandled open text inputs in Indian ATS chatbots
      answer = 'NA';
    }
  }

  // Type answer into chatbot text input
  const typed = await typeIntoChatbotInput(page, answer);
  if (!typed) {
    // If typing failed, check if we can skip
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
    // 1. Wait briefly for the Save button to become enabled
    await page.waitForFunction(
      () => {
        const sendDiv = document.querySelector('div.send');
        if (sendDiv && !sendDiv.classList.contains('disabled')) return true;
        const btn = document.querySelector('button');
        if (btn && btn.textContent?.trim() === 'Save' && !btn.disabled) return true;
        return false;
      },
      { timeout: 3000 }
    ).catch(() => {});

    // 2. Try clicking active Save button
    const saveSelectors = [
      `${CHATBOT_DRAWER} div.send:not(.disabled) div.sendMsg`,
      `${CHATBOT_DRAWER} div.send:not(.disabled)`,
      `${CHATBOT_DRAWER} button:has-text("Save"):not([disabled])`,
      'div.send:not(.disabled) div.sendMsg',
      'div.send:not(.disabled)',
      'button:has-text("Save"):not([disabled])',
      `${CHATBOT_DRAWER} button:has-text("Save")`,
      'button:has-text("Save")',
      'div.sendMsg',
    ];

    for (const sel of saveSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(1500);
          return true;
        }
      } catch {}
    }

    // 3. Fallback: try pressing Enter on keyboard (in chatbots, Enter sends message)
    try {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      return true;
    } catch {}

    // 4. If Save button is still disabled, check if "Skip this question" is present
    const skipped = await clickChatbotSkip(page);
    if (skipped) return true;

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

const MAX_CHATBOT_STEPS = 15;

/**
 * Handle the Naukri chatbot apply flow: detect questions, answer them,
 * upload resume when prompted, and stop when the chatbot completes.
 */
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
      if (sameQuestionCount >= 2) {
        console.warn(`[naukri] Bot repeating question: "${questionText}". Attempting skip/fallback.`);
        const skipped = await clickChatbotSkip(page);
        if (skipped) {
          const submitted = await waitForNaukriSubmission(page, 3000);
          if (submitted) {
            await closeNaukriChatbotDrawer(page);
            return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
          }
          continue;
        }
        // If cannot skip, resolve the proper contextual answer (never hardcode 'NA' for numbers/experience/yes-no)
        let fallbackAns = resolveChatbotTextAnswer(questionText, profile, companyName);
        if (!fallbackAns) {
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
          try { await page.bringToFront(); } catch {}
          bringWindowToFront('Chrome');
          return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
        }

        await clickChatbotSave(page);
        const submitted = await waitForNaukriSubmission(page, 3000);
        if (submitted) {
          await closeNaukriChatbotDrawer(page);
          return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
        }
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

      if (!autoSubmit) {
        console.log('[naukri] Resume uploaded to chatbot. Waiting for user action before Save.');
        try { await page.bringToFront(); } catch {}
        bringWindowToFront('Chrome');
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: uploaded, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 3500);
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

      if (!autoSubmit) {
        console.log(`[naukri] Radio question answered: "${questionText}". Waiting for user action before Save.`);
        try { await page.bringToFront(); } catch {}
        bringWindowToFront('Chrome');
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 3500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'checkbox') {
      const answered = await answerCheckboxQuestion(page, questionText, profile);
      if (answered) filledFields.push(questionText.slice(0, 50));

      if (!autoSubmit) {
        console.log(`[naukri] Checkbox question answered: "${questionText}". Waiting for user action before Save.`);
        try { await page.bringToFront(); } catch {}
        bringWindowToFront('Chrome');
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 3500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'text') {
      const answered = await answerTextQuestion(page, questionText, profile, companyName, jobTitle);
      if (answered) filledFields.push(questionText.slice(0, 50));

      if (!autoSubmit) {
        console.log(`[naukri] Text question answered: "${questionText}". Waiting for user action before Save.`);
        try { await page.bringToFront(); } catch {}
        bringWindowToFront('Chrome');
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 3500);
      if (submitted) {
        console.log('[naukri] Application submitted successfully detected after answering text question!');
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    if (qType === 'select') {
      // Try to pick a reasonable option from the select
      try {
        const select = page.locator(`${CHATBOT_DRAWER} select`).first();
        const options = await select.locator('option').allTextContents();
        const goodOption = options.find((o) => /yes|full.?time|permanent/i.test(o)) || options.find((o) => o.trim() && o.trim() !== 'Select');
        if (goodOption) {
          await select.selectOption({ label: goodOption.trim() }).catch(() => {});
          filledFields.push(questionText.slice(0, 50));
        }
      } catch {
        // continue
      }

      if (!autoSubmit) {
        console.log(`[naukri] Select question answered: "${questionText}". Waiting for user action before Save.`);
        try { await page.bringToFront(); } catch {}
        bringWindowToFront('Chrome');
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }

      await clickChatbotSave(page);
      const submitted = await waitForNaukriSubmission(page, 3500);
      if (submitted) {
        await closeNaukriChatbotDrawer(page);
        return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
      }
      continue;
    }

    // Unknown question type — try skip first, else click save
    const skipped = await clickChatbotSkip(page);
    if (!skipped) {
      if (!autoSubmit) {
        try { await page.bringToFront(); } catch {}
        bringWindowToFront('Chrome');
        return { status: 'stopped_for_review', readyForSubmit: true, filledFields, resumeAttached: true, stepCount };
      }
      await clickChatbotSave(page);
    }
    const submitted = await waitForNaukriSubmission(page, 3500);
    if (submitted) {
      await closeNaukriChatbotDrawer(page);
      return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
    }
  }

  // After chatbot completes, close the drawer and check if application was submitted
  await closeNaukriChatbotDrawer(page);
  await page.waitForTimeout(800);
  const finalSubmitted = await detectNaukriApplicationSubmitted(page);
  if (finalSubmitted) {
    return { status: 'submitted', filledFields, resumeAttached: true, stepCount };
  }

  return { status: 'stopped_for_review', filledFields, resumeAttached: true, stepCount };
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
}): Promise<PlatformResult> {
  const { jobUrl, profile, resumePdfBytes, resumeFilename, companyName, jobTitle, autoSubmit } = opts;

  if (!fs.existsSync(BROWSER_PROFILE_DIR)) {
    fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  }

  if (isApplyCancelled()) {
    return { status: 'cancelled', filledFields: [], resumeAttached: false, stepCount: 0, error: 'Auto-apply stopped by user' };
  }

  let ctx: BrowserContext | null = null;
  try {
    ctx = await launchApplyBrowser(BROWSER_PROFILE_DIR, { focus: true });

    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try { await page.bringToFront(); } catch {}
    bringWindowToFront('Chrome');
    await page.waitForTimeout(3500);

    // Wait for page content to settle
    await page.locator('button, a, input').first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});

    // Safety: login check
    if (await detectNaukriLoginRequired(page)) {
      try { await page.bringToFront(); } catch {}
      bringWindowToFront('Chrome');
      ctx = null; // Leave browser open so user can log in
      return {
        status: 'login_required',
        filledFields: [],
        resumeAttached: false,
        stepCount: 0,
        error: 'Naukri login required. Please log into your Naukri account in the Chrome window.',
      };
    }

    // Safety: CAPTCHA check
    if (await detectNaukriCaptcha(page)) {
      bringWindowToFront('Chrome');
      return { status: 'captcha', filledFields: [], resumeAttached: false, stepCount: 0, error: 'CAPTCHA detected on the job page. Please solve it manually.' };
    }

    // Check if this job supports direct apply
    const easyApply = await detectNaukriEasyApply(page);
    if (!easyApply) {
      return { status: 'error', filledFields: [], resumeAttached: false, stepCount: 0, error: 'This job requires applying on the company website (not Naukri Easy Apply).' };
    }

    // Pre-apply: Update candidate profile with the tailored resume before applying
    let profileResumeUpdated = false;
    const shouldUpdateProfile = opts.updateProfileResume ?? getApplyConfig().updateNaukriProfileResume ?? true;
    if (shouldUpdateProfile && resumePdfBytes && resumePdfBytes.length > 0) {
      try {
        const profilePage = await ctx.newPage();
        profileResumeUpdated = await updateNaukriProfileResume(profilePage, resumeFilename, resumePdfBytes);
        await profilePage.close().catch(() => {});
        try { await page.bringToFront(); } catch {}
      } catch (err) {
        console.warn('[naukri] Pre-apply profile resume upload warning:', err);
      }
    }

    // Click the apply button to start the flow
    let applyClicked = false;
    for (const sel of APPLY_BUTTON_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await btn.click({ timeout: 5000 });
          applyClicked = true;
          break;
        }
      } catch {
        // try next
      }
    }

    if (!applyClicked) {
      return { status: 'error', filledFields: [], resumeAttached: false, stepCount: 0, error: 'Could not find or click the Apply button.' };
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
      } else if (result.status === 'stopped_for_review') {
        result.readyForSubmit = true;
      }

      if (result.status === 'cancelled') {
        if (ctx) await ctx.close().catch(() => {});
        ctx = null;
        return result;
      }

      // Bring browser to front for confirmation / review
      try { await page.bringToFront(); } catch { /* ignore */ }
      bringWindowToFront('Chrome');

      ctx = null;
      return result;
    }

    // No chatbot — standard form apply (1-click direct apply)
    await page.waitForTimeout(2500);
    const isSubmitted = await detectNaukriApplicationSubmitted(page);
    if (isSubmitted) {
      await closeNaukriChatbotDrawer(page);
    }

    try { await page.bringToFront(); } catch { /* ignore */ }
    bringWindowToFront('Chrome');
    ctx = null;

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
