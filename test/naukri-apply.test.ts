import { describe, it, expect } from 'vitest';
import {
  detectNaukriEasyApply,
  detectNaukriCaptcha,
  detectNaukriLoginRequired,
  updateNaukriProfileResume,
  matchExperienceOption,
  resolveChatbotTextAnswer,
  clickChatbotSkip,
  closeNaukriChatbotDrawer,
  detectNaukriApplicationSubmitted,
  answerCheckboxQuestion,
  matchCityResidenceQuestion,
} from '@/lib/apply/naukri';

/**
 * Minimal Playwright `Page` fake for the pure detection and profile update functions.
 */

interface FakeLocatorExpr {
  present: boolean;
  visible?: boolean;
  text?: string;
}

class FakeLocator {
  public lastSetFiles: unknown = null;

  constructor(private expr: FakeLocatorExpr) {}

  async count(): Promise<number> {
    return this.expr.present ? 1 : 0;
  }

  async isVisible(): Promise<boolean> {
    return this.expr.visible ?? true;
  }

  first(): FakeLocator {
    return this;
  }

  getAttribute(): Promise<string | null> {
    return Promise.resolve(null);
  }

  async setInputFiles(files: unknown): Promise<void> {
    this.lastSetFiles = files;
  }

  async click(_opts?: unknown): Promise<void> {
    return Promise.resolve();
  }

  async innerText(): Promise<string> {
    return Promise.resolve(this.expr.text ?? 'Applied');
  }

  filter(_options?: { hasText?: RegExp }): FakeLocator {
    return this;
  }

  nth(_n: number): FakeLocator {
    return this;
  }

  locator(selector: string): FakeLocator {
    const isPresent = this.expr.present;
    const text = /label/i.test(selector) ? 'Bengaluru' : this.expr.text;
    return new FakeLocator({ present: isPresent, text });
  }
}

class FakePage {
  private presentSelectors: string[];
  bodyText: string;
  public visitedUrls: string[] = [];
  public currentUrl: string;

  constructor(opts: { presentSelectors?: string[]; bodyText?: string; url?: string } = {}) {
    this.presentSelectors = opts.presentSelectors ?? [];
    this.bodyText = opts.bodyText ?? '';
    this.currentUrl = opts.url ?? 'https://www.naukri.com/job-listings';
  }

  url(): string {
    return this.currentUrl;
  }

  locator(selector: string): FakeLocator {
    const isPresent = this.presentSelectors.some((s) => selector.toLowerCase().includes(s.toLowerCase()));
    const text = /label/i.test(selector) ? 'Bengaluru' : undefined;
    return new FakeLocator({ present: isPresent, text });
  }

  async evaluate<T>(_fn: () => T): Promise<T> {
    return this.bodyText as unknown as T;
  }

  async goto(url: string): Promise<void> {
    this.visitedUrls.push(url);
  }

  async waitForTimeout(_ms: number): Promise<void> {}

  async waitForSelector(_sel: string, _opts?: unknown): Promise<void> {}
}

describe('Naukri adapter detection', () => {
  it('returns true for direct apply (Easy Apply) when the company-site button is absent', async () => {
    const page = new FakePage({ presentSelectors: ['apply-button'] });
    await expect(detectNaukriEasyApply(page as never)).resolves.toBe(true);
  });

  it('returns false when the company-site button is present (external apply only)', async () => {
    const page = new FakePage({ presentSelectors: ['company-site-button', 'apply-button'] });
    await expect(detectNaukriEasyApply(page as never)).resolves.toBe(false);
  });

  it('returns false when no apply button exists', async () => {
    const page = new FakePage({ presentSelectors: [] });
    await expect(detectNaukriEasyApply(page as never)).resolves.toBe(false);
  });

  it('detects a CAPTCHA body message', async () => {
    const page = new FakePage({ bodyText: 'Please verify you are human to continue.' });
    await expect(detectNaukriCaptcha(page as never)).resolves.toBe(true);
  });

  it('returns false on a normal job page', async () => {
    const page = new FakePage({ bodyText: 'Data Engineer at Acme Corp' });
    await expect(detectNaukriCaptcha(page as never)).resolves.toBe(false);
  });

  it('detects the login-apply button (not authenticated)', async () => {
    const page = new FakePage({ presentSelectors: ['login-apply-button'] });
    await expect(detectNaukriLoginRequired(page as never)).resolves.toBe(true);
  });

  it('returns false when authenticated (no login button)', async () => {
    const page = new FakePage({ presentSelectors: [] });
    await expect(detectNaukriLoginRequired(page as never)).resolves.toBe(false);
  });
});

describe('Naukri profile resume upload', () => {
  it('navigates to mnjuser/profile and uploads PDF when attachCV is present', async () => {
    const page = new FakePage({ presentSelectors: ['attachcv'] });
    const dummyBytes = new Uint8Array([1, 2, 3, 4]);
    const result = await updateNaukriProfileResume(page as never, 'Hariharan_Data_Engineer.pdf', dummyBytes);

    expect(result).toBe(true);
    expect(page.visitedUrls).toContain('https://www.naukri.com/mnjuser/profile');
  });

  it('aborts upload if redirected to login page', async () => {
    const page = new FakePage({ presentSelectors: ['login-to-apply'] });
    const dummyBytes = new Uint8Array([1, 2, 3, 4]);
    const result = await updateNaukriProfileResume(page as never, 'Hariharan_Data_Engineer.pdf', dummyBytes);

    expect(result).toBe(false);
  });

  it('returns false if no file input or update button is found on profile', async () => {
    const page = new FakePage({ presentSelectors: [] });
    const dummyBytes = new Uint8Array([1, 2, 3, 4]);
    const result = await updateNaukriProfileResume(page as never, 'Hariharan_Data_Engineer.pdf', dummyBytes);

    expect(result).toBe(false);
  });
});

describe('Naukri experience option bracket matching', () => {
  const options = ['No experience', '<3 years', '3-5 years', '5-7 years', '7-8 years', '>8 years'];

  it('selects 3-5 years for candidate with 3 years of experience', () => {
    const idx = matchExperienceOption(options, 3);
    expect(options[idx]).toBe('3-5 years');
  });

  it('selects 3-5 years for candidate with 4 years of experience', () => {
    const idx = matchExperienceOption(options, 4);
    expect(options[idx]).toBe('3-5 years');
  });

  it('selects <3 years for candidate with 1 or 2 years of experience', () => {
    const idx = matchExperienceOption(options, 2);
    expect(options[idx]).toBe('<3 years');
  });

  it('selects 5-7 years for candidate with 6 years of experience', () => {
    const idx = matchExperienceOption(options, 6);
    expect(options[idx]).toBe('5-7 years');
  });

  it('selects >8 years for candidate with 10 years of experience', () => {
    const idx = matchExperienceOption(options, 10);
    expect(options[idx]).toBe('>8 years');
  });
});

describe('Naukri chatbot text question resolution (resolveChatbotTextAnswer)', () => {
  const profile = {
    name: 'Hariharan Subramaniyan',
    email: 'cshariharan2001@gmail.com',
    phone: '6383827363',
    location: 'Madurai, India',
    linkedin: 'https://linkedin.com/in/cshariharan01',
    currentCompany: 'Solartis Technology',
    currentJobTitle: 'Data Engineer',
    yearsOfExperience: 3,
    noticePeriodDays: 30,
    currentCtcInr: 700000,
    expectedCtcInr: 1200000,
    portfolioUrl: 'https://github.com/cshariharan01',
    experience: ['Software Engineer at Solartis Technology (Jan 2022 – Present)'],
  };

  it('answers "NA" for ex-infosys employee question when candidate never worked there', () => {
    const q = 'Are you ex-infosys employee ?if yes mention your infosys employee id if not, write NA';
    const answer = resolveChatbotTextAnswer(q, profile, 'Infosys');
    expect(answer).toBe('NA');
  });

  it('answers "NA" for ex-TCS question with "else NA"', () => {
    const q = 'Are you an ex-employee of TCS? If yes mention employee ID, else NA';
    const answer = resolveChatbotTextAnswer(q, profile, 'TCS');
    expect(answer).toBe('NA');
  });

  it('answers "NA" for previous employee ID prompt with "if not, write NA"', () => {
    const q = 'Previous Employee ID (if not, write NA)';
    const answer = resolveChatbotTextAnswer(q, profile, 'Infosys');
    expect(answer).toBe('NA');
  });

  it('answers "No" for direct ex-employee question without NA instruction', () => {
    const q = 'Are you ex-infosys employee ?';
    const answer = resolveChatbotTextAnswer(q, profile, 'Infosys');
    expect(answer).toBe('No');
  });

  it('answers current CTC in LPA format', () => {
    const q = 'What is your current CTC in LPA?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('7.0 LPA');
  });

  it('answers expected CTC in LPA format', () => {
    const q = 'What is your expected CTC?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('12.0 LPA');
  });

  it('answers notice period in days when requested in days', () => {
    const q = 'Notice period in days';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('30');
  });

  it('answers notice period with Days suffix for standard question', () => {
    const q = 'What is your notice period?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('30 Days');
  });

  it('answers total experience in years', () => {
    const q = 'Total years of experience in PySpark?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('3');
  });

  it('answers "Yes" for relocation willingness', () => {
    const q = 'Are you willing to relocate to Bengaluru?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('Yes');
  });

  it('answers current location from profile', () => {
    const q = 'Where are you currently located?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('Madurai, India');
  });

  it('answers highest qualification from profile', () => {
    const q = 'Highest qualification?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('B.E. Computer Science and Engineering');
  });

  it('answers "NA" for unknown optional question with "else NA"', () => {
    const q = 'Do you have AWS Solution Architect certification? if not write NA';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('NA');
  });

  it('answers "No" for "Are you residing curretly in Hydrabad ?" when candidate is in Madurai', () => {
    const q = 'Are you residing curretly in Hydrabad ?';
    const answer = resolveChatbotTextAnswer(q, profile, 'Datagaps');
    expect(answer).toBe('No');
  });

  it('answers "No" for "Are you residing currently in Hyderabad ?', () => {
    const q = 'Are you residing currently in Hyderabad ?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('No');
  });

  it('answers "Yes" for "Are you residing in Madurai ?" when candidate is in Madurai', () => {
    const q = 'Are you residing in Madurai ?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('Yes');
  });

  it('answers "No" for "Do you currently stay in Hyderabad ?"', () => {
    const q = 'Do you currently stay in Hyderabad ?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('No');
  });

  it('answers "No" for "Do you live in Chennai?"', () => {
    const q = 'Do you live in Chennai?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('No');
  });

  it('answers "No" for "Are you based in Hyderabad?"', () => {
    const q = 'Are you based in Hyderabad?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('No');
  });

  it('answers "Yes" for "Are you located in Madurai, India?"', () => {
    const q = 'Are you located in Madurai, India?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('Yes');
  });

  it('answers "Yes" for "Are you residing in Hyderabad or willing to relocate ?"', () => {
    const q = 'Are you residing in Hyderabad or willing to relocate ?';
    const answer = resolveChatbotTextAnswer(q, profile);
    expect(answer).toBe('Yes');
  });

  it('answers "Yes" for work from office and hybrid questions', () => {
    expect(resolveChatbotTextAnswer('Can you work from office in Hyderabad?', profile)).toBe('Yes');
    expect(resolveChatbotTextAnswer('Are you comfortable with hybrid / on-site work?', profile)).toBe('Yes');
  });
});

describe('Naukri chatbot skip button (clickChatbotSkip)', () => {
  it('clicks skip button when visible in the chatbot drawer', async () => {
    const page = new FakePage({ presentSelectors: ['skip-btn'] });
    const result = await clickChatbotSkip(page as never);
    expect(result).toBe(true);
  });

  it('returns false when no skip button is present', async () => {
    const page = new FakePage({ presentSelectors: [] });
    const result = await clickChatbotSkip(page as never);
    expect(result).toBe(false);
  });
});

describe('Naukri chatbot drawer close (closeNaukriChatbotDrawer)', () => {
  it('clicks crossIcon when visible in the drawer', async () => {
    const page = new FakePage({ presentSelectors: ['crossicon'] });
    const result = await closeNaukriChatbotDrawer(page as never);
    expect(result).toBe(true);
  });

  it('returns false when no close button is present', async () => {
    const page = new FakePage({ presentSelectors: [] });
    const result = await closeNaukriChatbotDrawer(page as never);
    expect(result).toBe(false);
  });
});

describe('Naukri application submission detection (detectNaukriApplicationSubmitted)', () => {
  it('detects "applied successfully" in page text', async () => {
    const page = new FakePage({ bodyText: 'Thank you! You have applied successfully to Infosys.' });
    const result = await detectNaukriApplicationSubmitted(page as never);
    expect(result).toBe(true);
  });

  it('detects "already applied" in page text', async () => {
    const page = new FakePage({ bodyText: 'You have already applied to this job on Naukri.' });
    const result = await detectNaukriApplicationSubmitted(page as never);
    expect(result).toBe(true);
  });

  it('detects "Applied" button element', async () => {
    const page = new FakePage({ presentSelectors: ['button:has-text("Applied")'] });
    const result = await detectNaukriApplicationSubmitted(page as never);
    expect(result).toBe(true);
  });

  it('returns false for unapplied page without success text', async () => {
    const page = new FakePage({ bodyText: 'PySpark Data Engineer at Infosys. Apply now.' });
    const result = await detectNaukriApplicationSubmitted(page as never);
    expect(result).toBe(false);
  });

  it('detects "thank you for your responses" completion message', async () => {
    const page = new FakePage({ bodyText: 'Thank you for your responses. Application submitted.' });
    const result = await detectNaukriApplicationSubmitted(page as never);
    expect(result).toBe(true);
  });

  it('detects submission via /myapply/saveApply redirect URL', async () => {
    const page = new FakePage({ url: 'https://www.naukri.com/myapply/saveApply?strJobsarr=[270826020961]&multiApplyResp={"270826020961":200}' });
    const result = await detectNaukriApplicationSubmitted(page as never);
    expect(result).toBe(true);
  });
});

describe('Naukri multi-select checkbox answering (answerCheckboxQuestion)', () => {
  it('selects matching location option when available', async () => {
    const page = new FakePage({ presentSelectors: ['multiselectcheckboxes', 'mcc__label'] });
    const profile = {
      name: 'Hariharan Subramaniyan',
      email: 'cshariharan2001@gmail.com',
      phone: '6383827363',
      location: 'Bengaluru',
    };
    const result = await answerCheckboxQuestion(page as never, 'Which is your preferred location?', profile as never);
    expect(result).toBe(true);
  });
});