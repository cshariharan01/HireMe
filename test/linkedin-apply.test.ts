import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectLinkedInEasyApply,
  detectLinkedInSubmit,
  detectLinkedInCaptcha,
  detectLinkedInLoginRequired,
  detectLinkedInExternalApply,
  easyApplyModalVisible,
  resolveLinkedInQuestionAnswer,
} from '@/lib/apply/linkedin';

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