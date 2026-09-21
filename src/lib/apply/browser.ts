// Browser autofill assistant — opens a Playwright Chromium window with the application URL,
// auto-fills standard text fields (name/email/phone/linkedin/location), attaches resume PDF
// + cover letter text, then hands off to the user to review + click Submit.
//
// Once the user submits, we detect success by polling for thank-you URL or heading patterns,
// then close the browser and record the outcome.
//
// Why visible (non-headless)?
//   - Zero ToS risk: the user is the one who clicks Submit, not us.
//   - User can edit any auto-filled field before submission.
//   - Works on snowflake portals where we can't anticipate every field.
//
// Why persistent context?
//   - Cookies / login state survive across sessions (Wellfound, some company portals need login).
//   - First-time use: user logs in manually; cookies persist for next time.

import { type BrowserContext, type Page, type Locator } from 'playwright';
import path from 'path';
import fs from 'fs';
import { launchApplyBrowser, bringWindowToFront, AUTO_APPLY_SUCCESS_PAGE } from './launcher';
import { resolveLinkedInQuestionAnswerAsync } from './linkedin';

const BROWSER_PROFILE_DIR = path.join(process.cwd(), 'data', 'playwright', 'browser-profile');

// Success indicators — substrings/patterns on the post-submit page that strongly suggest
// the application was received. We poll for either URL changes or visible text matching these.
const SUCCESS_URL_PATTERNS = /\/(thank|thanks|thank-you|thankyou|success|confirmation|confirmed|submitted|application-submitted|applied|received|complete|completed|done|acknowledg)\/?($|\?|#)/i;
const SUCCESS_TEXT_PATTERNS = /\b(thank you|application (was |successfully )?(received|submitted|sent)|we[' ]?ve received|thanks for (applying|your (application|interest))|your application (has been|was) (received|submitted|sent)|received your application|submission (was )?successful|application (complete|completed|confirmed)|successfully applied|we will be in touch|we[' ]?ll be in touch)\b/i;

export interface BrowserAutofillInput {
  url: string;
  profile: Record<string, unknown>;
  questions?: Array<{
    name?: string;
    label?: string;
    value?: unknown;
  }>;
  resumePdfBuf?: Uint8Array;
  resumeFilename?: string;
  coverLetterText?: string;
  jobTitle?: string;
  company?: string;
  /** Max wait for the user to submit, in ms. Default 8 min. */
  timeoutMs?: number;
  /**
   * Called when the submission watch finally settles, when `detachWait` is set.
   *
   * The watch can legitimately run for MINUTES — it is waiting for a human to finish a form — so
   * with `detachWait` the caller gets the autofill result immediately and this fires later.
   */
  onSettled?: (r: { detected: boolean; finalUrl?: string; durationMs: number }) => void;
  /**
   * Return as soon as the form is filled instead of blocking until the user submits.
   *
   * WHY: `browserAutofill` was awaited directly inside the apply API route, so that route held a
   * request open for up to EIGHT MINUTES while a human filled in a form. That is the same failure
   * shape as the unbounded LLM await that wedged the dev server. The browser window and the watch
   * both still run — they just no longer hold the HTTP request. Results arrive via `onSettled`.
   */
  detachWait?: boolean;
}

export interface BrowserAutofillResult {
  ok: boolean;
  detectedSubmission: boolean;
  /** True when we returned early and the submission watch is still running in the background. */
  watchPending?: boolean;
  filledFields: string[];        // labels of fields we auto-filled
  attachedFiles: string[];       // filenames attached
  finalUrl?: string;
  durationMs: number;
  error?: string;
}

// ----- Field filling heuristics ---------------------------------------

interface FieldRule {
  label: string;
  // Multiple selector strategies, tried in order
  selectors: string[];
  // The value to fill from the profile
  resolve: (profile: Record<string, unknown>) => string | null;
}

function firstName(full: string | undefined): string | null {
  if (!full) return null;
  const parts = full.trim().split(/\s+/);
  return parts[0] || null;
}
function lastName(full: string | undefined): string | null {
  if (!full) return null;
  const parts = full.trim().split(/\s+/);
  return parts.length < 2 ? null : parts.slice(1).join(' ');
}

const FIELD_RULES: FieldRule[] = [
  {
    label: 'First Name',
    selectors: [
      'input[name*="first_name" i]',
      'input[name*="firstname" i]',
      'input[name*="given" i]',
      'input[id*="first_name" i]',
      'input[id*="firstname" i]',
      'input[placeholder*="first name" i]',
      'input[aria-label*="first name" i]',
    ],
    resolve: (p) => firstName(p.name as string | undefined),
  },
  {
    label: 'Last Name',
    selectors: [
      'input[name*="last_name" i]',
      'input[name*="lastname" i]',
      'input[name*="family" i]',
      'input[name*="surname" i]',
      'input[id*="last_name" i]',
      'input[id*="lastname" i]',
      'input[placeholder*="last name" i]',
      'input[aria-label*="last name" i]',
    ],
    resolve: (p) => lastName(p.name as string | undefined),
  },
  {
    label: 'Full Name',
    selectors: [
      'input[name="name" i]',
      'input[name="full_name" i]',
      'input[name="fullname" i]',
      'input[id="name" i]',
      'input[id="full_name" i]',
      'input[placeholder*="full name" i]',
    ],
    resolve: (p) => (p.name as string) || null,
  },
  {
    label: 'Email',
    selectors: [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
      'input[aria-label*="email" i]',
    ],
    resolve: (p) => (p.email as string) || null,
  },
  {
    label: 'Phone',
    selectors: [
      'input[type="tel"]',
      'input[name*="phone" i]',
      'input[name*="mobile" i]',
      'input[id*="phone" i]',
      'input[placeholder*="phone" i]',
      'input[aria-label*="phone" i]',
    ],
    resolve: (p) => (p.phone as string) || null,
  },
  {
    label: 'LinkedIn',
    selectors: [
      'input[name*="linkedin" i]',
      'input[id*="linkedin" i]',
      'input[placeholder*="linkedin" i]',
      'input[aria-label*="linkedin" i]',
    ],
    resolve: (p) => (p.linkedin as string) || null,
  },
  {
    label: 'Location',
    selectors: [
      'input[name*="city" i]',
      'input[name*="location" i]',
      'input[id*="location" i]:not([type="hidden"])',
      'input[placeholder*="city" i]',
      'input[placeholder*="location" i]',
    ],
    resolve: (p) => (p.location as string) || null,
  },
  {
    label: 'Street Address',
    selectors: [
      'input[name*="street" i]',
      'input[name*="address_line" i]',
      'input[name*="addressline" i]',
      'input[name*="address1" i]',
      'input[name="address" i]',
      'input[id*="street" i]',
      'input[id*="address" i]',
      'input[placeholder*="street" i]',
      'input[placeholder*="address" i]',
      'input[aria-label*="street" i]',
      'input[aria-label*="address" i]',
    ],
    resolve: (p) =>
      (p.street as string) ||
      (p.streetAddress as string) ||
      (p.address as string) ||
      (p.location as string)?.split(',')[0]?.trim() ||
      null,
  },
  {
    label: 'City',
    selectors: [
      'input[name*="city" i]',
      'input[id*="city" i]',
      'input[placeholder*="city" i]',
      'input[aria-label*="city" i]',
    ],
    resolve: (p) =>
      (p.city as string) ||
      (p.location as string)?.split(',')[0]?.trim() ||
      null,
  },
  {
    label: 'State',
    selectors: [
      'input[name*="state" i]',
      'input[name*="province" i]',
      'input[name*="region" i]',
      'input[id*="state" i]',
      'input[id*="province" i]',
      'select[name*="state" i]',
      'select[name*="province" i]',
      'input[placeholder*="state" i]',
      'input[placeholder*="province" i]',
      'input[aria-label*="state" i]',
      'input[aria-label*="province" i]',
    ],
    resolve: (p) => (p.state as string) || (p.province as string) || 'Tamil Nadu',
  },
  {
    label: 'Country',
    selectors: [
      'input[name*="country" i]',
      'select[name*="country" i]',
      'input[id*="country" i]',
      'select[id*="country" i]',
      'input[placeholder*="country" i]',
      'input[aria-label*="country" i]',
    ],
    resolve: (p) => (p.country as string) || 'India',
  },
  {
    label: 'Postal Code',
    selectors: [
      'input[name*="zip" i]',
      'input[name*="postal" i]',
      'input[name*="pincode" i]',
      'input[id*="zip" i]',
      'input[id*="postal" i]',
      'input[id*="pincode" i]',
      'input[placeholder*="zip" i]',
      'input[placeholder*="postal" i]',
      'input[placeholder*="pincode" i]',
      'input[aria-label*="zip" i]',
      'input[aria-label*="postal" i]',
    ],
    resolve: (p) =>
      (p.zipCode as string) ||
      (p.postalCode as string) ||
      (p.pincode as string) ||
      (p.zip as string) ||
      '625001',
  },
  {
    label: 'Current Salary',
    selectors: [
      'input[name*="current_salary" i]',
      'input[name*="currentsalary" i]',
      'input[name*="current_ctc" i]',
      'input[name*="currentctc" i]',
      'input[id*="current_salary" i]',
      'input[id*="currentsalary" i]',
      'input[id*="current_ctc" i]',
      'input[placeholder*="current salary" i]',
      'input[placeholder*="current ctc" i]',
      'input[aria-label*="current salary" i]',
      'input[aria-label*="current ctc" i]',
    ],
    resolve: (p) =>
      p.currentCtcInr != null
        ? String(p.currentCtcInr)
        : (p.currentSalary as string) || (p.currentCtc as string) || '700000',
  },
  {
    label: 'Expected Salary',
    selectors: [
      'input[name*="expected_salary" i]',
      'input[name*="expectedsalary" i]',
      'input[name*="expected_ctc" i]',
      'input[name*="expectedctc" i]',
      'input[id*="expected_salary" i]',
      'input[id*="expectedsalary" i]',
      'input[id*="expected_ctc" i]',
      'input[placeholder*="expected salary" i]',
      'input[placeholder*="expected ctc" i]',
      'input[aria-label*="expected salary" i]',
      'input[aria-label*="expected ctc" i]',
    ],
    resolve: (p) =>
      p.expectedCtcInr != null
        ? String(p.expectedCtcInr)
        : (p.expectedSalary as string) || (p.expectedCtc as string) || '1200000',
  },
  {
  label: 'Current Company',
  selectors: [
    'input[name*="company" i]',
    'input[id*="company" i]',
    'input[placeholder*="company" i]',
  ],
  resolve: (p) =>
    (p.currentCompany as string) ||
    (p.company as string) ||
    null,
  },
  {
    label: 'Current Job Title',
    selectors: [
      'input[name*="job_title" i]',
      'input[name*="jobtitle" i]',
      'input[id*="job_title" i]',
      'input[placeholder*="job title" i]',
    ],
    resolve: (p) =>
      (p.currentJobTitle as string) ||
      (p.jobTitle as string) ||
      null,
  },
  {
    label: 'Notice Period',
    selectors: [
      'input[name*="notice" i]',
      'input[id*="notice" i]',
      'input[placeholder*="notice" i]',
      'input[aria-label*="notice" i]',
    ],
    resolve: (p) => String((p.noticePeriodDays as number) ?? 30),
  },
  {
    label: 'Years of Experience',
    selectors: [
      'input[name*="experience" i]',
      'input[name*="exp" i]',
      'input[id*="experience" i]',
      'input[placeholder*="experience" i]',
      'input[aria-label*="experience" i]',
    ],
    resolve: (p) => String((p.yearsOfExperience as number) ?? (p.yearsExperience as number) ?? 3),
  },
];

async function tryFill(
  page: Page,
  rule: FieldRule,
  value: string,
): Promise<boolean> {
  // 1. Prefer accessible labels.
  // This is especially important for Ashby forms.
  const labelPatterns: RegExp[] = [
    new RegExp(rule.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  ];

  // Common ATS label variations
  if (/first.?name/i.test(rule.label)) {
    labelPatterns.push(/first\s*name/i, /given\s*name/i);
  }

  if (/last.?name/i.test(rule.label)) {
    labelPatterns.push(/last\s*name/i, /family\s*name/i, /surname/i);
  }

  if (/email/i.test(rule.label)) {
    labelPatterns.push(/email\s*address/i, /^email$/i);
  }

  if (/phone/i.test(rule.label)) {
    labelPatterns.push(/phone\s*number/i, /mobile/i, /telephone/i);
  }

  if (/linkedin/i.test(rule.label)) {
    labelPatterns.push(/linkedin/i, /linkedin\s*(url|profile)/i);
  }

  if (/location/i.test(rule.label)) {
    labelPatterns.push(
      /^location$/i,
      /current\s*location/i,
      /city/i,
      /city.*state/i,
    );
  }

  if (/street/i.test(rule.label)) {
    labelPatterns.push(/street\s*address/i, /address\s*(?:line\s*1)?/i, /^street$/i, /^address$/i);
  }

  if (/city/i.test(rule.label)) {
    labelPatterns.push(/^city$/i, /city\s*or\s*locality/i, /town/i);
  }

  if (/state/i.test(rule.label)) {
    labelPatterns.push(/^state$/i, /state\s*\/\s*province/i, /province/i, /region/i);
  }

  if (/country/i.test(rule.label)) {
    labelPatterns.push(/^country$/i, /country\s*\/\s*region/i, /nation/i);
  }

  if (/postal|zip/i.test(rule.label)) {
    labelPatterns.push(/zip\s*code/i, /postal\s*code/i, /^zip$/i, /^pincode$/i, /pin\s*code/i);
  }

  if (/current.*(?:salary|ctc)/i.test(rule.label)) {
    labelPatterns.push(
      /\b(?:current|present)\b.*?\b(?:ctc|salary|compensation|remuneration|package|pay)\b/i,
      /what\s+is\s+your\s+current\s+salary/i,
      /current\s*salary/i,
      /current\s*ctc/i,
    );
  }

  if (/expected.*(?:salary|ctc)/i.test(rule.label)) {
    labelPatterns.push(
      /\b(?:expected|target|desired)\b.*?\b(?:ctc|salary|compensation|remuneration|package|pay)\b/i,
      /what\s+is\s+your\s+expected\s+salary/i,
      /expected\s*salary/i,
      /expected\s*ctc/i,
    );
  }

  if (/notice.*period|notice/i.test(rule.label)) {
    labelPatterns.push(
      /\b(?:notice\s*period|days?\s*notice|how\s*soon.*(?:join|start)|joining\s*(?:time|period|days)|join\s*us.*days)\b/i,
      /notice\s*period/i,
    );
  }

  if (/experience/i.test(rule.label)) {
    labelPatterns.push(
      /(?:total|overall|relevant|work|professional|it)\s*(?:years?\s*of\s*)?experience/i,
      /years?\s*of\s*(?:work\s*)?experience/i,
      /total\s*experience/i,
    );
  }

async function fillOrSelectElement(loc: Locator, value: string): Promise<boolean> {
  const tagName = await loc.evaluate((el: HTMLElement) => el.tagName.toLowerCase()).catch(() => '');
  if (tagName === 'select') {
    try {
      await loc.selectOption({ label: value });
      return true;
    } catch {
      try {
        await loc.selectOption(value);
        return true;
      } catch {
        const optionVal = await loc.evaluate((sel: HTMLSelectElement, targetVal: string) => {
          const norm = targetVal.toLowerCase();
          for (const opt of Array.from(sel.options)) {
            if (opt.text.toLowerCase().includes(norm) || opt.value.toLowerCase().includes(norm)) {
              return opt.value;
            }
          }
          return null;
        }, value).catch(() => null);
        if (optionVal) {
          await loc.selectOption(optionVal);
          return true;
        }
      }
    }
    return false;
  }

  const existing = await loc.inputValue().catch(() => '');
  if (existing?.trim() && !['0', '0.00', '1', '3'].includes(existing.trim())) return true;

  await loc.fill(value, { timeout: 3000 });
  return true;
}

  for (const pattern of labelPatterns) {
    try {
      const loc = page.getByLabel(pattern).first();

      if ((await loc.count()) === 0) continue;

      const visible = await loc.isVisible().catch(() => false);
      const disabled = await loc.isDisabled().catch(() => false);

      if (!visible || disabled) continue;

      if (/location/i.test(rule.label)) {
        const ok = await tryFillAutocomplete(page, /location/i, value);
        if (ok) return true;
      }

      const ok = await fillOrSelectElement(loc, value);
      if (ok) return true;
    } catch {
      // try next approach
    }
  }

  // 2. Original selector-based fallback
  for (const sel of rule.selectors) {
    const loc = page.locator(sel).first();

    try {
      if ((await loc.count()) === 0) continue;

      const visible = await loc.isVisible().catch(() => false);
      const disabled = await loc.isDisabled().catch(() => false);

      if (!visible || disabled) continue;

      const ok = await fillOrSelectElement(loc, value);
      if (ok) return true;
    } catch {
      // try next selector
    }
  }

  // 3. Ashby/general ATS visible-label fallback.
  // Find a container whose visible text matches the field label,
  // then locate an input/textarea inside it.
  for (const pattern of labelPatterns) {
    try {
      const containers = page.locator('label, div').filter({
        hasText: pattern,
      });

      const count = Math.min(await containers.count(), 10);

      for (let i = 0; i < count; i++) {
        const container = containers.nth(i);

        const input = container
          .locator(
            'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
          )
          .first();

        if ((await input.count()) === 0) continue;

        const visible = await input.isVisible().catch(() => false);
        const disabled = await input.isDisabled().catch(() => false);

        if (!visible || disabled) continue;

        const ok = await fillOrSelectElement(input, value);
        if (ok) return true;
      }
    } catch {
      // continue
    }
  }

  return false;
}

async function tryFillAutocomplete(
  page: Page,
  labelPattern: RegExp,
  value: string,
): Promise<boolean> {
  try {
    const input = page.getByLabel(labelPattern).first();

    if ((await input.count()) === 0) return false;

    await input.fill(value, { timeout: 3000 });
    await page.waitForTimeout(800);

    const option = page.getByRole('option').first();

    if ((await option.count()) > 0) {
      await option.click({ timeout: 3000 });
      return true;
    }

    await input.press('ArrowDown').catch(() => {});
    await input.press('Enter').catch(() => {});

    return true;
  } catch {
    return false;
  }
}

async function fillApplicationQuestion(
  page: Page,
  label: string,
  rawValue: unknown,
): Promise<boolean> {
  if (rawValue === undefined || rawValue === null) return false;

  const value = String(rawValue).trim();
  if (!value) return false;

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelPattern = new RegExp(escapedLabel, 'i');

  // ---------------------------------------------------------
  // 1. Native <select>
  // ---------------------------------------------------------
  try {
    const select = page.getByLabel(labelPattern).first();

    if (
      (await select.count()) > 0 &&
      (await select.evaluate((el) => el.tagName.toLowerCase())) === 'select'
    ) {
      try {
        await select.selectOption({ label: value });
        return true;
      } catch {
        try {
          await select.selectOption(value);
          return true;
        } catch {
          // continue
        }
      }
    }
  } catch {
    // continue
  }

  // ---------------------------------------------------------
  // 2. Locate the question container.
  // Prefer fieldset because radio questions commonly use it.
  // ---------------------------------------------------------
  let container = page.locator('fieldset').filter({
    hasText: labelPattern,
  }).first();

  try {
    if ((await container.count()) === 0) {
      container = page.locator('div').filter({
        hasText: labelPattern,
      }).first();
    }
  } catch {
    // ignore
  }

  // ---------------------------------------------------------
  // 3. Radio buttons — Yes / No and other choices
  // ---------------------------------------------------------
  try {
    if ((await container.count()) > 0) {
      const radio = container.getByRole('radio', {
        name: new RegExp(
          `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          'i',
        ),
      }).first();

      if ((await radio.count()) > 0) {
        await radio.check({ timeout: 3000 });
        return true;
      }
    }
  } catch {
    // continue
  }

  // ---------------------------------------------------------
  // 4. Radio via associated label text
  // ---------------------------------------------------------
  try {
    if ((await container.count()) > 0) {
      const optionLabel = container
        .locator('label')
        .filter({
          hasText: new RegExp(
            `^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
            'i',
          ),
        })
        .first();

      if ((await optionLabel.count()) > 0) {
        await optionLabel.click({ timeout: 3000 });
        return true;
      }
    }
  } catch {
    // continue
  }

  // ---------------------------------------------------------
  // 5. Ashby / custom buttons
  // Some choice controls are buttons instead of native radios.
  // ---------------------------------------------------------
  try {
    if ((await container.count()) > 0) {
      const button = container.getByRole('button', {
        name: new RegExp(
          `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          'i',
        ),
      }).first();

      if ((await button.count()) > 0) {
        await button.click({ timeout: 3000 });
        return true;
      }
    }
  } catch {
    // continue
  }

  // ---------------------------------------------------------
  // 6. Checkbox
  // ---------------------------------------------------------
  const normalized = value.toLowerCase();

  if (
    normalized === 'yes' ||
    normalized === 'true' ||
    normalized === 'checked'
  ) {
    try {
      const checkbox = page.getByLabel(labelPattern).first();

      if (
        (await checkbox.count()) > 0 &&
        (await checkbox.getAttribute('type')) === 'checkbox'
      ) {
        if (!(await checkbox.isChecked())) {
          await checkbox.check({ timeout: 3000 });
        }

        return true;
      }
    } catch {
      // continue
    }
  }

  // ---------------------------------------------------------
  // 7. Combobox / custom dropdown
  // ---------------------------------------------------------
  try {
    const combobox = page.getByLabel(labelPattern).first();

    if ((await combobox.count()) > 0) {
      const role = await combobox.getAttribute('role');

      if (role === 'combobox') {
        await combobox.click();

        const option = page.getByRole('option', {
          name: new RegExp(
            `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            'i',
          ),
        }).first();

        if ((await option.count()) > 0) {
          await option.click();
          return true;
        }
      }
    }
  } catch {
    // continue
  }

  // ---------------------------------------------------------
  // 8. Text response question
  // ---------------------------------------------------------
  try {
    const input = page.getByLabel(labelPattern).first();

    if ((await input.count()) > 0) {
      const tag = await input.evaluate((el) => el.tagName.toLowerCase());
      const type = await input.getAttribute('type');

      if (
        tag === 'textarea' ||
        (
          tag === 'input' &&
          !['radio', 'checkbox', 'file', 'hidden'].includes(type || '')
        )
      ) {
        const existing = await input.inputValue().catch(() => '');

        if (!existing.trim()) {
          await input.fill(value, { timeout: 3000 });
        }

        return true;
      }
    }
  } catch {
    // continue
  }

  return false;
}

// ----- File attachment ----------------------------------------------------

async function attachResume(
  page: Page,
  resumeFilename: string,
  resumeBytes: Uint8Array,
): Promise<boolean> {
  const file = {
    name: resumeFilename,
    mimeType: 'application/pdf',
    buffer: Buffer.from(resumeBytes),
  };

  // 1. Accessible label — useful for Ashby
  for (const pattern of [/resume/i, /\bcv\b/i, /upload.*resume/i]) {
    try {
      const loc = page.getByLabel(pattern).first();

      if (
        (await loc.count()) > 0 &&
        (await loc.getAttribute('type')) === 'file'
      ) {
        await loc.setInputFiles(file);
        return true;
      }
    } catch {
      // continue
    }
  }

  // 2. ATS-specific / generic selectors
  const candidates = [
    'input[type="file"][name*="resume" i]',
    'input[type="file"][name*="cv" i]',
    'input[type="file"][id*="resume" i]',
    'input[type="file"][id*="cv" i]',
    '[data-testid*="resume" i] input[type="file"]',
    '[data-testid*="upload" i] input[type="file"]',
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();

    try {
      if ((await loc.count()) === 0) continue;

      await loc.setInputFiles(file);
      return true;
    } catch {
      // continue
    }
  }

  // 3. Find the file input nearest visible "Resume" text
  try {
    const resumeContainers = page
      .locator('label, div, section')
      .filter({ hasText: /resume|\bcv\b/i });

    const count = Math.min(await resumeContainers.count(), 15);

    for (let i = 0; i < count; i++) {
      const fileInput = resumeContainers
        .nth(i)
        .locator('input[type="file"]')
        .first();

      if ((await fileInput.count()) === 0) continue;

      await fileInput.setInputFiles(file);
      return true;
    }
  } catch {
    // continue
  }

  // 4. Last fallback ONLY when there is exactly one file input.
  // This avoids accidentally uploading the resume as a cover letter.
  try {
    const allFiles = page.locator('input[type="file"]');
    const count = await allFiles.count();

    if (count === 1) {
      await allFiles.first().setInputFiles(file);
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

async function attachCoverLetter(
  page: Page,
  filename: string,
  text: string,
): Promise<boolean> {
  const content = text.slice(0, 8000);

  // 1. Accessible label
  try {
    const textarea = page.getByLabel(/cover\s*letter/i).first();

    if ((await textarea.count()) > 0) {
      const visible = await textarea.isVisible().catch(() => false);

      if (visible) {
        await textarea.fill(content, { timeout: 3000 });
        return true;
      }
    }
  } catch {
    // continue
  }

  // 2. Normal textarea selectors
  const textareaSelectors = [
    'textarea[name*="cover" i]',
    'textarea[id*="cover" i]',
    'textarea[placeholder*="cover" i]',
    'textarea[aria-label*="cover" i]',
  ];

  for (const sel of textareaSelectors) {
    const loc = page.locator(sel).first();

    try {
      if ((await loc.count()) === 0) continue;

      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;

      await loc.fill(content, { timeout: 3000 });
      return true;
    } catch {
      // continue
    }
  }

  // 3. Find textarea near visible Cover Letter text
  try {
    const containers = page
      .locator('label, div, section')
      .filter({ hasText: /cover\s*letter/i });

    const count = Math.min(await containers.count(), 15);

    for (let i = 0; i < count; i++) {
      const textarea = containers.nth(i).locator('textarea').first();

      if ((await textarea.count()) === 0) continue;

      const visible = await textarea.isVisible().catch(() => false);
      if (!visible) continue;

      await textarea.fill(content, { timeout: 3000 });
      return true;
    }
  } catch {
    // continue
  }

  // 4. Cover-letter file upload fallback
  const fileSelectors = [
    'input[type="file"][name*="cover" i]',
    'input[type="file"][id*="cover" i]',
  ];

  for (const sel of fileSelectors) {
    const loc = page.locator(sel).first();

    try {
      if ((await loc.count()) === 0) continue;

      await loc.setInputFiles({
        name: filename,
        mimeType: 'text/plain',
        buffer: Buffer.from(new TextEncoder().encode(text)),
      });

      return true;
    } catch {
      // continue
    }
  }

  return false;
}

// ----- Success polling ----------------------------------------------------

async function waitForSubmissionOrTimeout(
  ctx: BrowserContext,
  page: Page,
  timeoutMs: number,
): Promise<{ detected: boolean; finalUrl?: string }> {
  const start = Date.now();
  let lastUrl = page.url();
  while (Date.now() - start < timeoutMs) {
    // Was the browser closed by the user?
    if (ctx.pages().length === 0) return { detected: false, finalUrl: lastUrl };
    try {
      lastUrl = page.url();
    } catch {
      // page might be detached
      return { detected: false, finalUrl: lastUrl };
    }
    // URL match
    if (SUCCESS_URL_PATTERNS.test(lastUrl)) return { detected: true, finalUrl: lastUrl };
    // Text match — read visible body text (truncated for speed)
    try {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
      if (bodyText && SUCCESS_TEXT_PATTERNS.test(bodyText)) {
        return { detected: true, finalUrl: lastUrl };
      }
    } catch { /* page closed or detached */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { detected: false, finalUrl: lastUrl };
}

// ----- Main entry ---------------------------------------------------------

export interface AutofillPageInput {
  profile: Record<string, unknown>;
  resumePdfBuf?: Uint8Array;
  resumeFilename?: string;
  coverLetterText?: string;
}

/**
 * Fill an EXISTING page's application form with the generic heuristics (standard
 * fields, resume PDF, cover letter) WITHOUT launching a browser or navigating.
 *
 * Exposed for the platform adapters' external-apply handoff: when a LinkedIn job has
 * no Easy Apply but carries an offsite "Apply" link, the adapter navigates the SAME
 * window/context to that link and reuses these in-page fillers. It must not call
 * `browserAutofill` — that launches a fresh persistent context on the same profile
 * dir, which Chromium refuses while the adapter's context is still open.
 */
export async function autofillPage(
  page: Page,
  input: AutofillPageInput,
): Promise<{ filledFields: string[]; attachedFiles: string[] }> {
  const filledFields: string[] = [];
  const attachedFiles: string[] = [];

  // 1. Fill text fields
  for (const rule of FIELD_RULES) {
    const val = rule.resolve(input.profile);
    if (!val) continue;
    const ok = await tryFill(page, rule, val);
    if (ok) filledFields.push(rule.label);
  }

  // 1b. LLM-powered screening for open-ended textarea questions
  // (e.g. external ATS like Modash, Ashby, Greenhouse custom questions)
  try {
    const textareas = page.locator('textarea');
    const taCount = await textareas.count();
    for (let i = 0; i < taCount; i++) {
      try {
        const ta = textareas.nth(i);
        if (!(await ta.isVisible().catch(() => false))) continue;
        if (await ta.isDisabled().catch(() => false)) continue;
        const existing = await ta.inputValue().catch(() => '');
        if (existing?.trim()) continue; // skip already-filled

        // Extract the label / question text for this textarea
        const label = await ta.evaluate((el) => {
          if (el.getAttribute('aria-label')) return el.getAttribute('aria-label') || '';
          const id = el.id;
          if (id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl?.textContent?.trim()) return lbl.textContent.trim();
          }
          // Walk up to find a question container with a label/heading
          let node: HTMLElement | null = el.parentElement;
          for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
            // Prefer the first <p> or <label> or heading sibling above the textarea
            const candidates = Array.from(
              node.querySelectorAll<HTMLElement>('label, legend, h1, h2, h3, h4, p, [role="heading"]')
            );
            for (const c of candidates) {
              const txt = c.textContent?.replace(/\s+/g, ' ').trim();
              if (txt && txt.length > 5 && txt.length < 2000) return txt;
            }
          }
          return el.getAttribute('placeholder') || el.getAttribute('name') || '';
        }).catch(() => '');

        if (!label) continue;

        const answer = await resolveLinkedInQuestionAnswerAsync(label, 'textarea', input.profile as Record<string, unknown>);
        if (answer) {
          await ta.scrollIntoViewIfNeeded().catch(() => {});
          await ta.focus().catch(() => {});
          await ta.fill(answer);
          await ta.dispatchEvent('input').catch(() => {});
          await ta.dispatchEvent('change').catch(() => {});
          filledFields.push(`Textarea: ${label.slice(0, 50)}`);
        }
      } catch {
        // skip individual textarea errors
      }
    }
  } catch {
    // skip entire textarea scan if page is in transition
  }

  // 2. Attach resume PDF
  if (input.resumePdfBuf) {
    const ok = await attachResume(page, input.resumeFilename || 'resume.pdf', input.resumePdfBuf);
    if (ok) attachedFiles.push(input.resumeFilename || 'resume.pdf');
  }

  // 3. Attach cover letter (textarea first, file fallback)
  if (input.coverLetterText) {
    const ok = await attachCoverLetter(page, 'cover-letter.txt', input.coverLetterText);
    if (ok) attachedFiles.push('cover-letter.txt');
  }

  return { filledFields, attachedFiles };
}

/** Check required legal/agreement controls rendered by employer ATS widgets. These often use a
 * hidden input plus a custom label, so getByLabel() alone cannot reach them. Optional demographic
 * and marketing checkboxes are deliberately excluded by the text guard. */
async function checkTermsAndAgreementBoxes(page: Page): Promise<string[]> {
  const checked: string[] = [];
  try {
    const labels = await page.locator('label, [role="checkbox"], oj-checkbox, [data-automation-id*="checkbox" i]').all();
    for (const control of labels.slice(0, 30)) {
      const text = ((await control.innerText().catch(() => '')) || (await control.getAttribute('aria-label').catch(() => '')) || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!/(terms?|conditions?|privacy|consent|agree|certif|accurate|acknowledge)/i.test(text)) continue;
      if (/marketing|newsletter|subscribe|job alert|demographic|gender|race|ethnicity/i.test(text)) continue;
      try {
        const native = control.locator('input[type="checkbox"]').first();
        if ((await native.count()) > 0) {
          if (!(await native.isChecked().catch(() => false))) await native.check({ force: true, timeout: 3000 });
          checked.push(text || 'terms checkbox');
          continue;
        }
        const role = control.getByRole('checkbox').first();
        if ((await role.count()) > 0) {
          const state = await role.getAttribute('aria-checked').catch(() => null);
          if (state !== 'true') await role.click({ force: true, timeout: 3000 });
          checked.push(text || 'terms checkbox');
          continue;
        }
        await control.click({ force: true, timeout: 3000 });
        checked.push(text || 'terms checkbox');
      } catch {
        // One custom control should not prevent the remaining form from progressing.
      }
    }
  } catch { /* page may be between SPA renders */ }

  // Oracle can render the checkbox input separately from the visible text label. In that shape
  // getByLabel/label traversal sees no useful text, so inspect the nearest field container.
  try {
    const inputs = await page.locator('input[type="checkbox"]').all();
    for (const input of inputs.slice(0, 30)) {
      const details = await input.evaluate((element) => {
        let node: HTMLElement | null = element.parentElement;
        for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
          const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
          if (text.length >= 8) return { text: text.slice(0, 800), visible: !!(node.offsetWidth || node.offsetHeight) };
        }
        return { text: '', visible: !!(element as HTMLElement).offsetParent };
      }).catch(() => ({ text: '', visible: false }));
      if (!details.visible || !/(terms?|conditions?|privacy|consent|agree|certif|accurate|acknowledge)/i.test(details.text)) continue;
      if (/marketing|newsletter|subscribe|job alert|demographic|gender|race|ethnicity/i.test(details.text)) continue;
      if (!(await input.isChecked().catch(() => false))) {
        await input.check({ force: true, timeout: 3000 });
        checked.push(details.text);
      }
    }
  } catch { /* custom controls may not expose native inputs */ }

  // Last Oracle fallback: the text can be rendered in a sibling component while the checkbox
  // itself has no label or useful parent text. Only use this when the current page clearly talks
  // about terms/consent and exposes at most a few checkboxes, so optional preferences are not
  // selected indiscriminately.
  try {
    const pageText = await page.locator('body').innerText().catch(() => '');
    const controls = page.locator('input[type="checkbox"], [role="checkbox"], oj-checkbox');
    const count = await controls.count();
    if (count > 0 && count <= 4 && /(terms?|conditions?|privacy|consent|agree|acknowledge|certif)/i.test(pageText)) {
      for (let index = 0; index < count; index++) {
        const control = controls.nth(index);
        const visible = await control.isVisible().catch(() => false);
        if (!visible) continue;
        const type = await control.getAttribute('type').catch(() => null);
        const checkedState = type === 'checkbox'
          ? await control.isChecked().catch(() => false)
          : (await control.getAttribute('aria-checked').catch(() => null)) === 'true';
        if (checkedState) continue;
        await control.click({ force: true, timeout: 3000 });
        checked.push('unlabeled terms checkbox');
      }
    }
  } catch { /* page may be between SPA renders */ }

  // Last-resort Oracle JET interaction. Its visible checkbox is often a wrapper around a hidden
  // input, and Playwright's check() can succeed without updating the component model. Click the
  // wrapper/associated label and emit the same events the component listens for.
  try {
    const clicked = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"], oj-checkbox')) as HTMLElement[];
      const pageText = document.body?.innerText || '';
      const termsPage = /(terms?|conditions?|privacy|consent|agree|acknowledge|certif)/i.test(pageText);
      if (!termsPage || controls.length > 4) return 0;
      let count = 0;
      for (const control of controls) {
        const input = control.matches('input') ? (control as HTMLInputElement) : control.querySelector<HTMLInputElement>('input[type="checkbox"]');
        const checked = input ? input.checked : control.getAttribute('aria-checked') === 'true';
        if (checked) continue;
        let node: HTMLElement | null = control;
        let context = '';
        for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
          context = `${context} ${node.innerText || ''}`.replace(/\s+/g, ' ').trim();
          if (context.length > 20) break;
        }
        const relevant = /(terms?|conditions?|privacy|consent|agree|acknowledge|certif|accurate)/i.test(context);
        if (!relevant && controls.length > 1) continue;
        const id = input?.id;
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null : null;
        const target = label || control.closest('[role="checkbox"], oj-checkbox, label') as HTMLElement | null || control;
        target.scrollIntoView({ block: 'center' });
        target.click();
        if (input && !input.checked) {
          input.checked = true;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (target.getAttribute('role') === 'checkbox') target.setAttribute('aria-checked', 'true');
        count++;
      }
      return count;
    });
    if (clicked) {
      checked.push('Oracle checkbox wrapper');
      await page.waitForTimeout(500);
    }
  } catch { /* page may be between SPA renders */ }

  if (checked.length) console.log('[browser] checked agreement controls:', checked);
  return checked;
}

async function hasUnresolvedTermsCheckbox(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"], oj-checkbox')) as HTMLElement[];
      return controls.some((control) => {
        const text = [control.innerText, control.getAttribute('aria-label') || '', control.parentElement?.innerText || '']
          .join(' ')
          .replace(/\s+/g, ' ')
          .toLowerCase();
        if (!/(terms?|conditions?|privacy|consent|agree|certif|accurate|acknowledge)/i.test(text)) return false;
        if (/marketing|newsletter|subscribe|job alert|demographic|gender|race|ethnicity/i.test(text)) return false;
        const input = control.matches('input') ? (control as HTMLInputElement) : control.querySelector<HTMLInputElement>('input[type="checkbox"]');
        const checked = input ? input.checked : control.getAttribute('aria-checked') === 'true';
        return !checked && (!!(control.offsetWidth || control.offsetHeight) || !!control.parentElement?.offsetParent);
      });
    });
  } catch {
    return false;
  }
}

// ----- External ATS wizard traversal ----------------------------------------
//
// Employer career sites (Accenture, most Greenhouse/Lever/Ashby boards) walk the applicant through
// a MULTI-STEP wizard. The generic filler fills whichever step renders; these helpers then advance
// to the next step, close interstitial overlays ads/popups, and hand off at the final Submit —
// which stays a human click, always.

/** Labels of genuine "advance to the next step" buttons — NEVER the final Submit. */
const ADVANCE_LABELS = [
  'Next',
  'Continue',
  'Proceed',
  'Continue to next step',
  'Continue to review',
  'Continue to submission',
  'Save and continue',
  'Review',
  'Verify',
  'Next step',
  'Upload resume',
  'Add resume',
];

/** Labels that close overlay/chrome UI rather than advancing the application. */
const DISMISS_LABELS = [
  'Close',
  'No thanks',
  'Skip',
  'Not now',
  'Maybe later',
  'Got it',
];

export type { Page };

/** True when a real Submit button is visible — the wizard's final step, which must stay manual. */
export async function findSubmitButton(
  page: Page,
): Promise<ReturnType<Page['locator']> | null> {
  const submitted = ['Submit', 'Submit application', 'Send application', 'Send', 'Submit Application'];
  for (const label of submitted) {
    try {
      const loc = page
        .locator(`button:has-text("${label}"), input[type="submit"][value="${label}"], [role="button"]:has-text("${label}")`)
        .first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The wizard's confirm-modal "Submit" reads differently from the page's real Submit — catch those
 * too (they are still correct to leave manual; they virtually always sit right before a thank-you).
 */
export async function findConfirmSubmitButton(page: Page): Promise<ReturnType<Page['locator']> | null> {
  for (const label of ['Submit', 'Submit application', 'Send application', 'Send']) {
    try {
      const loc = page
        .locator(`[role="dialog"] button:has-text("${label}"), .modal button:has-text("${label}")`)
        .first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Close lightboxes, cookie banners and chat widgets that would swallow the next step's click. */
export async function dismissInterstitials(page: Page): Promise<number> {
  let closed = 0;
  const closeButtons = [
    'button[aria-label="Close"]',
    'span[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    '.close',
    '.icon-close',
    '[aria-label="close"]',
  ];
  for (const sel of closeButtons) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click({ timeout: 2000 }).catch(() => {});
        closed++;
        await page.waitForTimeout(250);
      }
    } catch { /* keep going */ }
  }
  for (const label of DISMISS_LABELS) {
    try {
      const loc = page
        .locator(`button:has-text("${label}")`)
        .filter({ visible: true })
        .first();
      if ((await loc.count()) === 0 || !(await loc.isVisible().catch(() => false))) continue;
      const text = ((await loc.textContent({ timeout: 1000 }).catch(() => '')) ?? '').trim();
      // Never click a DISMISS that is actually the page's real Submit ("Send" etc. is not here).
      if (text === label) {
        await loc.click({ timeout: 2000 }).catch(() => {});
        closed++;
        await page.waitForTimeout(250);
      }
    } catch { /* keep going */ }
  }
  return closed;
}

/** The visible button that advances the wizard, or null if the step has none (likely the final). */
export async function findAdvanceButton(
  page: Page,
): Promise<ReturnType<Page['locator']> | null> {
  // Explicitly never the final Submit — check and reject armed submit buttons first.
  if (await findSubmitButton(page)) return null;
  if (await findConfirmSubmitButton(page)) return null;
  for (const label of ADVANCE_LABELS) {
    try {
      const loc = page
        .locator(`button:has-text("${label}"), input[type="submit"][value*="${label}"], [role="button"]:has-text("${label}")`)
        .first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Fill a page with the generic heuristics AND, once the form calls for it, advance a multi-step
 * wizard until the final Submit — which is left untouched for the human. Interstitial overlays are
 * closed between steps. Re-fills every step because wizards reset untouched parts of the DOM.
 *
 * @returns everything filled across all steps + which step we stopped on (stop = saw Submit / no
 *          more advance buttons / max steps reached).
 */
export async function fillAndAdvanceWizard(
  page: Page,
  input: AutofillPageInput,
  maxSteps = 15,
): Promise<{ filledFields: string[]; attachedFiles: string[]; stepsAdvanced: number; stoppedAtSubmit: boolean }> {
  const filledFields: string[] = [];
  const attachedFiles: string[] = [];
  let stepsAdvanced = 0;
  let stoppedAtSubmit = false;

  for (let step = 0; step < maxSteps; step++) {
    await dismissInterstitials(page);

    const filled = await autofillPage(page, input);
    for (const f of filled.filledFields) if (!filledFields.includes(f)) filledFields.push(f);
    for (const a of filled.attachedFiles) if (!attachedFiles.includes(a)) attachedFiles.push(a);

    await checkTermsAndAgreementBoxes(page);

    // Never click Next while a required agreement is still unresolved. This is intentionally a
    // hard gate: Oracle rejects the step when the checkbox is not checked, and advancing first
    // loses the only page where the control can be addressed.
    if (await hasUnresolvedTermsCheckbox(page)) {
      console.warn('[browser] terms checkbox remains unchecked; refusing to click Next');
      await page.waitForTimeout(1000);
      await checkTermsAndAgreementBoxes(page);
      if (await hasUnresolvedTermsCheckbox(page)) break;
    }

    const pauseMs = 1200;
    await page.waitForTimeout(pauseMs);

    const confirmSubmit = await findConfirmSubmitButton(page);
    if (confirmSubmit) {
      // A confirm-submit modal means we are on the final review step. Stop — the human clicks it.
      stoppedAtSubmit = true;
      return { filledFields, attachedFiles, stepsAdvanced, stoppedAtSubmit };
    }
    if (await findSubmitButton(page)) {
      // Real Submit visible — the human reviews and clicks. We are done filling.
      stoppedAtSubmit = true;
      return { filledFields, attachedFiles, stepsAdvanced, stoppedAtSubmit };
    }

    const advance = await findAdvanceButton(page);
    if (!advance) break; // nothing to advance to — final manual step, or a page without a next.

    await dismissInterstitials(page);
    try {
      console.log('[browser] advance wizard step', stepsAdvanced + 1, 'via', ((await advance.textContent().catch(() => '')) ?? '').trim());
      await advance.click({ timeout: 5000 });
      stepsAdvanced++;
      await page.waitForTimeout(2600);
    } catch (e) {
      console.warn('[browser] advance click failed:', (e as Error).message);
      break;
    }
  }

  console.log('[browser] wizard reached maximum automation steps:', maxSteps);
  return { filledFields, attachedFiles, stepsAdvanced, stoppedAtSubmit };
}

export async function browserAutofill(input: BrowserAutofillInput): Promise<BrowserAutofillResult> {
  const start = Date.now();
  const timeoutMs = input.timeoutMs ?? 8 * 60 * 1000;
  // Declared at function scope: populated by `autofillPage` inside the try below and read in the
  // success AND failure return paths.
  let filledFields: string[] = [];
  let attachedFiles: string[] = [];

  if (!fs.existsSync(BROWSER_PROFILE_DIR)) {
    fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  }

  let ctx: BrowserContext | null = null;
  try {
    ctx = await launchApplyBrowser(BROWSER_PROFILE_DIR, { focus: true });

    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try { await page.bringToFront(); } catch {}
    bringWindowToFront('Chrome');
    // Settle: wait for any client-side hydration / form rendering
    await page.waitForTimeout(3500);

    // Wait specifically for an application form to appear.
    // Ashby renders much of its form client-side after initial page load.
    await page
      .locator('input, textarea, select')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});

    // 1-3. Fill fields, attach resume, attach cover letter (shared with the platform
    // adapters' external-apply handoff via `autofillPage` — one source of truth).
    ({ filledFields, attachedFiles } = await autofillPage(page, {
      profile: input.profile,
      resumePdfBuf: input.resumePdfBuf,
      resumeFilename: input.resumeFilename,
      coverLetterText: input.coverLetterText,
    }));

    // 4. Bring window forward + wait for user to review + submit
    try {
        console.log('[apply] browser autofill completed');
        console.log('[apply] filled fields:', filledFields);
        console.log('[apply] attached files:', attachedFiles);
        console.log('[apply] final page:', page.url());
        await page.bringToFront();
    } catch { /* ignore */ }

    if (input.detachWait) {
      // Hand the request back NOW; keep watching in the background.
      const watchCtx = ctx;
      ctx = null; // ownership moves to the watch below, so the catch block must not close it
      void (async () => {
        let detectedSubmission = false;
        try {
          const { detected, finalUrl } = await waitForSubmissionOrTimeout(watchCtx, page, timeoutMs);
          detectedSubmission = detected;
          input.onSettled?.({ detected, finalUrl, durationMs: Date.now() - start });
        } catch (e) {
          console.warn('[apply] background submission watch failed:', (e as Error).message);
        } finally {
          // Close ONLY when the submission was confirmed. On a timeout the user is very likely
          // still filling the form — this watch runs for eight minutes precisely because forms take
          // that long — and closing would destroy their work with no warning. That was tolerable
          // when the request blocked (they at least saw a spinner); now the dialog has told them
          // "we'll keep watching that window", so yanking it is worse. Leaving it open costs an
          // idle browser the user can close themselves.
          if (detectedSubmission) {
            try {
              const pages = watchCtx.pages();
              for (let i = 1; i < pages.length; i++) {
                await pages[i].close().catch(() => {});
              }
              if (pages[0] && !pages[0].isClosed()) {
                await pages[0].goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
              }
            } catch {
              await watchCtx.close().catch(() => {});
            }
          } else {
            console.warn('[apply] submission not confirmed within the watch window — leaving the browser window open so you can finish and submit.');
          }
        }
      })();

      return {
        ok: filledFields.length > 0,
        detectedSubmission: false,
        watchPending: true,
        filledFields,
        attachedFiles,
        finalUrl: input.url,
        durationMs: Date.now() - start,
      };
    }

    if (!ctx) throw new Error('Browser context unavailable');
    const { detected, finalUrl } = await waitForSubmissionOrTimeout(ctx, page, timeoutMs);

    if (detected) {
      try {
        const pages = ctx.pages();
        for (let i = 1; i < pages.length; i++) {
          await pages[i].close().catch(() => {});
        }
        if (pages[0] && !pages[0].isClosed()) {
          await pages[0].goto(AUTO_APPLY_SUCCESS_PAGE).catch(() => {});
        }
        ctx = null;
      } catch {
        if (ctx) await ctx.close().catch(() => {});
      }
    } else {
      if (ctx) await ctx.close().catch(() => {});
    }

    return {
      ok: detected || filledFields.length > 0,
      detectedSubmission: detected,
      filledFields,
      attachedFiles,
      finalUrl,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    if (ctx) await ctx.close().catch(() => {});
    return {
      ok: false,
      detectedSubmission: false,
      filledFields,
      attachedFiles,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}
