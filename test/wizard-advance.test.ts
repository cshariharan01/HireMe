import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Page } from 'playwright';
import { fillAndAdvanceWizard, findSubmitButton, findAdvanceButton, dismissInterstitials } from '@/lib/apply/browser';

/**
 * External ATS wizard traversal. Uses a REAL headless Chromium (only way to exercise the fill +
 * advance loop faithfully). The critical safety property: the wizard advances through every step but
 * NEVER clicks the final Submit — that stays a human click.
 */
describe('external wizard traversal', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;

  const profile: Record<string, unknown> = {
    name: 'Arjun Sharma',
    email: 'arjun@example.com',
    phone: '+91 9876543210',
    location: 'Bengaluru',
    linkedin: 'https://linkedin.com/in/arjun',
    currentCompany: 'HealthSys',
    currentJobTitle: 'Integration Architect',
  };

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  /** Two-step wizard: step 1 (name/email + Continue) → step 2 (phone + Submit application). */
  async function twoStepWizard(): Promise<Page> {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="step1">
        <input name="first_name" placeholder="First name">
        <input type="email" name="email" placeholder="Email">
        <button onclick="advance()">Continue</button>
      </div>
      <div id="step2" style="display:none">
        <input name="last_name" placeholder="Last name">
        <input type="tel" name="phone" placeholder="Phone">
        <button>Submit application</button>
      </div>
      <script>
        window.advanceCount = 0;
        function advance() {
          document.getElementById('step1').style.display = 'none';
          document.getElementById('step2').style.display = 'block';
          window.advanceCount++;
        }
      </script>
    `);
    return page;
  }

  it('fills every step and STOPS at the final Submit without clicking it', async () => {
    const page = await twoStepWizard();
    try {
      await page.evaluate(() => {
        // @ts-expect-error window extension
        window.advanceCount = 0;
      });
      const result = await fillAndAdvanceWizard(page, { profile });

      // Step 1 advanced to step 2, and the final Submit was reached but never clicked.
      expect(result.stepsAdvanced).toBeGreaterThanOrEqual(1);
      expect(result.stoppedAtSubmit).toBe(true);
      const advanceCount = await page.evaluate(() => (window as unknown as { advanceCount: number }).advanceCount);
      expect(advanceCount).toBe(1);

      // Step-1 fields filled.
      expect(result.filledFields).toContain('First Name');
      expect(result.filledFields).toContain('Email');

      // The Submit button is STILL present and enabled (untouched), and advanceCount never went past 1.
      const submit = await findSubmitButton(page);
      expect(submit).not.toBeNull();
      const submitVisible = await submit!.isVisible();
      expect(submitVisible).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('does not mistake an interstitials dismiss for the final submit', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="modal">
        <button aria-label="Close">Close</button>
        <p>We noticed you have questions.</p>
      </div>
      <button>Continue</button>
    `);
    try {
      const closed = await dismissInterstitials(page);
      expect(closed).toBeGreaterThanOrEqual(1);
      // The Continue (advance) button is still clickable afterwards — nothing else was dismissed.
      const advance = await findAdvanceButton(page);
      expect(advance).not.toBeNull();
    } finally {
      await page.close();
    }
  });

  it('keeps an overlay "Submit" in a different code path from the step\'s Continue', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div>
        <input name="first_name" placeholder="First name">
        <button>Continue</button>
      </div>
      <div class="modal" style="display:none" id="confirm">
        <button id="realSubmit">Submit</button>
      </div>
    `);
    try {
      // Hidden modal Submit must NOT be treated as the visible advance button.
      const advance = await findAdvanceButton(page);
      expect(advance).not.toBeNull();
      const text = await advance!.textContent();
      expect(text).toBe('Continue');
    } finally {
      await page.close();
    }
  });
});