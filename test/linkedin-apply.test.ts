import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectLinkedInEasyApply,
  detectLinkedInSubmit,
  detectLinkedInCaptcha,
  detectLinkedInLoginRequired,
  detectLinkedInExternalApply,
  easyApplyModalVisible,
  resolveLinkedInQuestionAnswer,
  resolveLinkedInQuestionAnswerAsync,
  resolvePreferredLocationOption,
} from '@/lib/apply/linkedin';
import db from '@/lib/db';
import { screeningOwnerId, hashScreeningQuestion, ensureScreeningOwner } from '@/lib/apply/screening-owner';

/**
 * Minimal Playwright `Page` fake for the pure detection functions.
 *
 * The detection helpers only touch `page.locator(sel).first().count()/isVisible()/getAttribute()`,
 * `page.evaluate`, and `page.url()`. A real browser launch is not needed — and the
 * safety property we care about (detect submit, never click) is a logic property
 * of the router/adapters, not of browser I/O.
 */

interface FakeLocatorExpr {
  present: boolean;
  visible?: boolean;
}

class FakeLocator {
  constructor(
    private expr: FakeLocatorExpr,
    private attributeValues: Array<{ selector: string; attr: string; value: string }>,
  ) {}

  async count(): Promise<number> {
    return this.expr.present ? 1 : 0;
  }

  async isVisible(): Promise<boolean> {
    return this.expr.visible ?? true;
  }

  async isDisabled(): Promise<boolean> {
    return false;
  }

  first<K extends FakeLocator>(this: K): K {
    return this;
  }

  async getAttribute(name: string): Promise<string | null> {
    for (const cfg of this.attributeValues) {
      if (cfg.attr === name) return cfg.value;
    }
    return null;
  }
}

interface FakePageOpts {
  /** CSS substrings that should "match" a locator query. */
  presentSelectors?: string[];
  /** Selectors that are present but hidden. */
  hiddenSelectors?: string[];
  bodyText?: string;
  url?: string;
  /** Selector substrings whose queried element will report a matching attribute value. */
  attributeValues?: Array<{ selector: string; attr: string; value: string }>;
}

class FakePage {
  private presentSelectors: string[];
  private hiddenSelectors: string[];
  private attributeValues: Array<{ selector: string; attr: string; value: string }>;
  bodyText: string;
  private _url: string;

  constructor(opts: FakePageOpts = {}) {
    this.presentSelectors = opts.presentSelectors ?? [];
    this.hiddenSelectors = opts.hiddenSelectors ?? [];
    this.attributeValues = opts.attributeValues ?? [];
    this.bodyText = opts.bodyText ?? '';
    this._url = opts.url ?? 'https://www.linkedin.com/jobs/view/123';
  }

  locator(selector: string): FakeLocator {
    const isPresent = this.presentSelectors.some((s) => selector.toLowerCase().includes(s.toLowerCase()));
    const isHidden = this.hiddenSelectors.some((s) => selector.toLowerCase().includes(s.toLowerCase()));
    const matches = this.attributeValues.filter((c) => selector.toLowerCase().includes(c.selector.toLowerCase()));
    return new FakeLocator({ present: isPresent && !isHidden, visible: !isHidden }, matches);
  }

  async evaluate<T>(_fn: () => T): Promise<T> {
    // The real functions call `document.body.innerText.slice(...)`; emulate with bodyText.
    // `_fn` is ignored — the fake returns the configured body text directly.
    return this.bodyText as unknown as T;
  }

  url(): string {
    return this._url;
  }
}

describe('LinkedIn adapter detection', () => {
  it('detects the Easy Apply button when visible', async () => {
    const page = new FakePage({ presentSelectors: ['jobs-apply-button'] });
    await expect(detectLinkedInEasyApply(page as never)).resolves.toBe(true);
  });

  it('detects Easy Apply via aria-label', async () => {
    const page = new FakePage({ presentSelectors: ['aria-label*="Easy Apply"'] });
    await expect(detectLinkedInEasyApply(page as never)).resolves.toBe(true);
  });

  it('returns false when no Easy Apply button exists', async () => {
    const page = new FakePage({ presentSelectors: ['some-other-button'] });
    await expect(detectLinkedInEasyApply(page as never)).resolves.toBe(false);
  });

  it('ignores a hidden Easy Apply button', async () => {
    const page = new FakePage({ presentSelectors: ['jobs-apply-button'], hiddenSelectors: ['jobs-apply-button'] });
    await expect(detectLinkedInEasyApply(page as never)).resolves.toBe(false);
  });
});

describe('LinkedIn external-apply detection', () => {
  it('returns the offsite href for an `<a class="jobs-apply-button">`', async () => {
    const page = new FakePage({
      presentSelectors: ['a.jobs-apply-button'],
      attributeValues: [{ selector: 'a.jobs-apply-button', attr: 'href', value: 'https://jobs.acme.com/apply/123' }],
    });
    await expect(detectLinkedInExternalApply(page as never)).resolves.toBe('https://jobs.acme.com/apply/123');
  });

  it('detects an offsite tracking link', async () => {
    const page = new FakePage({
      presentSelectors: ['data-tracking-control-name*="offsite"'],
      attributeValues: [{ selector: 'offsite', attr: 'href', value: 'https://careers.acme.com/posting/1' }],
    });
    await expect(detectLinkedInExternalApply(page as never)).resolves.toBe('https://careers.acme.com/posting/1');
  });

  it('returns null when href is javascript: or empty (never hand off to non-http)', async () => {
    const page = new FakePage({
      presentSelectors: ['a.jobs-apply-button'],
      attributeValues: [{ selector: 'a.jobs-apply-button', attr: 'href', value: 'javascript:void(0)' }],
    });
    await expect(detectLinkedInExternalApply(page as never)).resolves.toBe(null);
  });

  it('detects the new-design "Apply on company website" anchor and unwraps the /safety/go redirect', async () => {
    const page = new FakePage({
      presentSelectors: ['a[aria-label*="Apply on company website"]'],
      attributeValues: [{
        selector: 'a[aria-label*="Apply on company website"]',
        attr: 'href',
        value: 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fgrnh%2Ese%2Fi9zba1vc3us&urlhash=itLP&mt=ui',
      }],
    });
    await expect(detectLinkedInExternalApply(page as never)).resolves.toBe('https://grnh.se/i9zba1vc3us');
  });

  it('keeps a direct http(s) href untouched (no safety wrapper)', async () => {
    const page = new FakePage({
      presentSelectors: ['a[aria-label*="Apply on company website"]'],
      attributeValues: [{
        selector: 'a[aria-label*="Apply on company website"]',
        attr: 'href',
        value: 'https://careers.acme.com/posting/2',
      }],
    });
    await expect(detectLinkedInExternalApply(page as never)).resolves.toBe('https://careers.acme.com/posting/2');
  });

  it('returns null when the nearest anchor has javascript: or empty href', async () => {
    const page = new FakePage({
      presentSelectors: ['a[aria-label*="Apply"]'],
      attributeValues: [{ selector: 'a[aria-label*="Apply"]', attr: 'href', value: 'javascript:void(0)' }],
    });
    await expect(detectLinkedInExternalApply(page as never)).resolves.toBe(null);
  });

  it('returns null when only an Easy Apply button exists', async () => {
    const page = new FakePage({ presentSelectors: ['button.jobs-apply-button'] });
    await expect(detectLinkedInExternalApply(page as never)).resolves.toBe(null);
  });

  it('returns null when no apply control exists', async () => {
    const page = new FakePage({ presentSelectors: [] });
    await expect(detectLinkedInExternalApply(page as never)).resolves.toBe(null);
  });
});

describe('LinkedIn submit detection (never clicks)', () => {
  it('detects the Submit application button', async () => {
    const page = new FakePage({ presentSelectors: ['aria-label*="Submit application"'] });
    await expect(detectLinkedInSubmit(page as never)).resolves.toBe(true);
  });

  it('detects button by text', async () => {
    const page = new FakePage({ presentSelectors: ['"Submit application"'] });
    await expect(detectLinkedInSubmit(page as never)).resolves.toBe(true);
  });

  it('returns false when only a Next button exists (multi-step)', async () => {
    const page = new FakePage({ presentSelectors: ['"Next"'] });
    await expect(detectLinkedInSubmit(page as never)).resolves.toBe(false);
  });

  it('returns false when no submit button exists', async () => {
    const page = new FakePage({ presentSelectors: [] });
    await expect(detectLinkedInSubmit(page as never)).resolves.toBe(false);
  });
});

describe('LinkedIn CAPTCHA + login detection', () => {
  it('detects reCAPTCHA iframe', async () => {
    const page = new FakePage({ presentSelectors: ['recaptcha'] });
    await expect(detectLinkedInCaptcha(page as never)).resolves.toBe(true);
  });

  it('detects a security-check body message', async () => {
    const page = new FakePage({ bodyText: 'To continue, please verify you are human.' });
    await expect(detectLinkedInCaptcha(page as never)).resolves.toBe(true);
  });

  it('returns false on a normal page', async () => {
    const page = new FakePage({ bodyText: 'Senior Data Engineer at Acme' });
    await expect(detectLinkedInCaptcha(page as never)).resolves.toBe(false);
  });

  it('detects a login redirect', async () => {
    const page = new FakePage({ url: 'https://www.linkedin.com/login?fromSignIn=true' });
    await expect(detectLinkedInLoginRequired(page as never)).resolves.toBe(true);
  });

  it('returns false when logged in on a job page', async () => {
    const page = new FakePage({ url: 'https://www.linkedin.com/jobs/view/123' });
    await expect(detectLinkedInLoginRequired(page as never)).resolves.toBe(false);
  });
});

describe('LinkedIn Easy Apply modal visibility', () => {
  it('detects modal via role="dialog"', async () => {
    const page = new FakePage({ presentSelectors: ['[role="dialog"]'] });
    await expect(easyApplyModalVisible(page as never)).resolves.toBe(true);
  });

  it('detects modal via aria-modal="true"', async () => {
    const page = new FakePage({ presentSelectors: ['[aria-modal="true"]'] });
    await expect(easyApplyModalVisible(page as never)).resolves.toBe(true);
  });

  it('detects modal via .jobs-easy-apply-modal', async () => {
    const page = new FakePage({ presentSelectors: ['.jobs-easy-apply-modal'] });
    await expect(easyApplyModalVisible(page as never)).resolves.toBe(true);
  });

  it('detects modal via .artdeco-modal', async () => {
    const page = new FakePage({ presentSelectors: ['.artdeco-modal'] });
    await expect(easyApplyModalVisible(page as never)).resolves.toBe(true);
  });

  it('returns false when no modal selectors match', async () => {
    const page = new FakePage({ presentSelectors: ['div.job-details-page'] });
    await expect(easyApplyModalVisible(page as never)).resolves.toBe(false);
  });
});

describe('LinkedIn screening question resolution (resolveLinkedInQuestionAnswer)', () => {
  const profile = {
    name: 'Hariharan Subramaniyan',
    email: 'cshariharan2001@gmail.com',
    location: 'Madurai, India',
    street: 'Madurai',
    city: 'Madurai',
    state: 'Tamil Nadu',
    country: 'India',
    zipCode: '625001',
    yearsOfExperience: 3,
    totalExperienceMonths: 6,
    noticePeriodDays: 30,
    currentCtcInr: 570000,
    expectedCtcInr: 1200000,
    portfolioUrl: 'https://github.com/cshariharan01',
    dateOfBirth: '2001-05-15',
    skills: ['Python', 'Azure Databricks', 'Airflow', 'LLM', 'SQL'],
  };

  it('correctly resolves "Total experience ?*" with candidate experience years', () => {
    expect(resolveLinkedInQuestionAnswer('Total experience ?*', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('Total experience', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('Overall experience ?*', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('Relevant work experience ?*', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('Total IT experience ?*', 'text', profile)).toBe('3');
  });

  it('truncates decimal YOE (e.g. 3.6 years) down to 3 instead of rounding up to 4', () => {
    const decimalProfile = { ...profile, yearsOfExperience: 3.6 };
    expect(resolveLinkedInQuestionAnswer('How many years of work experience do you have with SQL?', 'text', decimalProfile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('How many years of work experience do you have with Python (Programming Language)?', 'text', decimalProfile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('How many years of work experience do you have with Microsoft Excel?', 'text', decimalProfile)).toBe('3');
  });

  it('correctly resolves "Once offered, how soon you can join us - in days ?*" with notice period days', () => {
    expect(resolveLinkedInQuestionAnswer('Once offered, how soon you can join us - in days ?*', 'text', profile)).toBe('30');
    expect(resolveLinkedInQuestionAnswer('How soon can you join us? - in days', 'text', profile)).toBe('30');
    expect(resolveLinkedInQuestionAnswer('When can you join us ?', 'text', profile)).toBe('30 days');
    expect(resolveLinkedInQuestionAnswer('Notice period (days)', 'text', profile)).toBe('30');
  });

  it('correctly resolves text-based Yes/No qualification questions', () => {
    expect(resolveLinkedInQuestionAnswer('Have you implemented RAG/LLM integrations on top of data platforms?*', 'text', profile)).toBe('Yes');
    expect(resolveLinkedInQuestionAnswer('Are you comfortable working from Bangalore Office ?*', 'text', profile)).toBe('Yes');
    expect(resolveLinkedInQuestionAnswer('Do you have experience in Python?*', 'text', profile)).toBe('Yes');
    expect(resolveLinkedInQuestionAnswer('Can you join immediately or within 30 days?*', 'text', profile)).toBe('Yes');
    expect(resolveLinkedInQuestionAnswer('Do you require visa sponsorship?*', 'text', profile)).toBe('No');
  });

  it('correctly resolves count questions like "How many production Databricks pipelines do you support?*"', () => {
    expect(resolveLinkedInQuestionAnswer('How many production Databricks pipelines do you support?*', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('How many projects have you deployed?*', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('Number of pipelines built', 'text', profile)).toBe('3');
  });

  it('correctly resolves specific skill experience questions', () => {
    expect(resolveLinkedInQuestionAnswer('How many years of work experience do you have with Azure Databricks?', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('How many years of work experience do you have with Airflow?*', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('How many years of work experience do you have with Large Language Models (LLM)?*', 'text', profile)).toBe('3');
  });

  it('correctly resolves Current and Expected CTC', () => {
    expect(resolveLinkedInQuestionAnswer('Current CTC ?*', 'text', profile)).toBe('570000');
    expect(resolveLinkedInQuestionAnswer('Expected CTC ?*', 'text', profile)).toBe('1200000');
  });

  it('provides a safe fallback for unknown mandatory questions', () => {
    expect(resolveLinkedInQuestionAnswer('Rate your problem-solving skill (1-10)?*', 'text', profile)).toBe('3');
    expect(resolveLinkedInQuestionAnswer('Will you be open to travel occasionally?*', 'text', profile)).toBe('Yes');
  });
});

describe('LinkedIn async screening question resolution (resolveLinkedInQuestionAnswerAsync)', () => {
  const profile = {
    email: 'cshariharan2001@gmail.com',
    yearsOfExperience: 3,
    noticePeriodDays: 30,
    currentCtcInr: 570000,
    expectedCtcInr: 1200000,
  };

  it('reuses answers from SQLite screening_answers profile cache when present', async () => {
    const ownerId = screeningOwnerId(profile);
    ensureScreeningOwner(ownerId);
    const question = 'Custom Radio Question: Are you willing to work night shifts?';
    const hash = hashScreeningQuestion(question, ownerId);

    db.prepare(`
      INSERT INTO screening_answers (question_hash, question, answer, category, used_count)
      VALUES (?, ?, ?, 'radio', 1)
      ON CONFLICT(question_hash) DO UPDATE SET answer = excluded.answer
    `).run(hash, question, 'Yes');

    const res = await resolveLinkedInQuestionAnswerAsync(question, 'radio', profile, ['Yes', 'No']);
    expect(res).toBe('Yes');
  });

  it('snaps cached answer to matching radio option from options list', async () => {
    const ownerId = screeningOwnerId(profile);
    ensureScreeningOwner(ownerId);
    const question = 'Custom Experience Range Question';
    const hash = hashScreeningQuestion(question, ownerId);

    db.prepare(`
      INSERT INTO screening_answers (question_hash, question, answer, category, used_count)
      VALUES (?, ?, ?, 'radio', 1)
      ON CONFLICT(question_hash) DO UPDATE SET answer = excluded.answer
    `).run(hash, question, '3-5 years');

    const res = await resolveLinkedInQuestionAnswerAsync(question, 'radio', profile, ['0-1 years', '1-3 years', '3-5 years', '5+ years']);
    expect(res).toBe('3-5 years');
  });

  it('correctly resolves radio button questions for work authorization, sponsorship, and qualification', () => {
    expect(resolveLinkedInQuestionAnswer('Authorized to work in India', 'radio', profile)).toBe('Yes');
    expect(resolveLinkedInQuestionAnswer('Are you legally authorized to work in the country?', 'radio', profile)).toBe('Yes');
    expect(resolveLinkedInQuestionAnswer('Will you now or in the future require visa sponsorship?', 'radio', profile)).toBe('No');
    expect(resolveLinkedInQuestionAnswer('Do you need visa sponsorship?', 'radio', profile)).toBe('No');
    expect(resolveLinkedInQuestionAnswer('Comfortable with hybrid work policy?', 'radio', profile)).toBe('Yes');
    expect(resolveLinkedInQuestionAnswer('Willing to relocate to Bangalore?', 'radio', profile)).toBe('Yes');
  });

  describe('Location preference matching (Zorba AI bug fix)', () => {
    const candidateProfile = {
      name: 'Hariharan Subramaniyan',
      email: 'cshariharan2001@gmail.com',
      city: 'Virudhunagar',
      state: 'Tamil Nadu',
      location: 'Virudhunagar, India',
      targets: {
        locations: ['Madurai', 'Coimbatore', 'Chennai', 'Bangalore', 'Remote'],
      },
    };

    it('matches candidate preference Chennai from Zorba AI options list instead of picking first option Mumbai', () => {
      const options = [
        'Mumbai, Maharashtra, India',
        'Bengaluru, Karnataka, India',
        'Chennai, Tamil Nadu, India',
      ];
      const matched = resolvePreferredLocationOption(options, candidateProfile);
      expect(matched).toBe('Chennai, Tamil Nadu, India');
    });

    it('matches Bangalore to Bengaluru using city aliases when Chennai is not present', () => {
      const options = [
        'Mumbai, Maharashtra, India',
        'Bengaluru, Karnataka, India',
        'Hyderabad, Telangana, India',
      ];
      const matched = resolvePreferredLocationOption(options, candidateProfile);
      expect(matched).toBe('Bengaluru, Karnataka, India');
    });

    it('matches Remote when available and preferred', () => {
      const remoteProfile = {
        city: 'Virudhunagar',
        targets: {
          locations: ['Remote', 'Bangalore'],
        },
      };
      const options = [
        'Mumbai, Maharashtra, India',
        'Work from home',
        'Pune, Maharashtra, India',
      ];
      const matched = resolvePreferredLocationOption(options, remoteProfile);
      expect(matched).toBe('Work from home');
    });

    it('matches candidate state when no exact city matches', () => {
      const stateProfile = {
        city: 'Virudhunagar',
        state: 'Tamil Nadu',
        targets: {
          locations: ['Tirunelveli'],
        },
      };
      const options = [
        'Mumbai, Maharashtra, India',
        'Trichy, Tamil Nadu, India',
        'Kolkata, West Bengal, India',
      ];
      const matched = resolvePreferredLocationOption(options, stateProfile);
      expect(matched).toBe('Trichy, Tamil Nadu, India');
    });

    it('resolves "Select your prefered location." question (single "r") with candidate preference', () => {
      const options = [
        'Mumbai, Maharashtra, India',
        'Bengaluru, Karnataka, India',
        'Chennai, Tamil Nadu, India',
      ];
      // Note spelling in prompt: "prefered" with one "r"
      const ans = resolveLinkedInQuestionAnswer(
        'Select your prefered location.',
        'radio',
        candidateProfile,
        true,
        options
      );
      expect(ans).toBe('Chennai, Tamil Nadu, India');
    });

    it('resolves "Preferred work location" for dropdown (select) input type', () => {
      const options = [
        'Select an option',
        'Mumbai, Maharashtra, India',
        'Bengaluru, Karnataka, India',
        'Chennai, Tamil Nadu, India',
      ];
      const ans = resolveLinkedInQuestionAnswer(
        'Preferred work location',
        'select',
        candidateProfile,
        true,
        options
      );
      expect(ans).toBe('Chennai, Tamil Nadu, India');
    });

    it('resolves async location question deterministically through resolveLinkedInQuestionAnswerAsync', async () => {
      const options = [
        'Mumbai, Maharashtra, India',
        'Bengaluru, Karnataka, India',
        'Chennai, Tamil Nadu, India',
      ];
      const res = await resolveLinkedInQuestionAnswerAsync(
        'Select your prefered location.',
        'radio',
        candidateProfile,
        options
      );
      expect(res).toBe('Chennai, Tamil Nadu, India');
    });
  });
});