import { describe, it, expect } from 'vitest';
import {
  identifySubmissionStrategy,
  submitsDirectly,
  strategyActionLabel,
  applicationUrl,
  type SubmissionStrategy,
} from '@/lib/apply/router';

/**
 * The router decides what the UI OFFERS, so a wrong answer here means promising the user an action
 * their portal cannot perform. `apply_audit` recorded 7 attempts all-time and zero successes, so
 * none of this was ever proven in production — these lock in the intent.
 */
describe('auto-apply routing is honest about what it can do', () => {
  it('Greenhouse routes to browser autofill, not direct submit', () => {
    /**
     * REGRESSION: Greenhouse was the one "really submits" path in the app, and it could never work.
     * `boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>` answers every POST with
     * `401 "HTTP Basic: Access denied."` and `WWW-Authenticate: Basic realm="Application"`.
     * A POST to a board slug that does not exist returns the SAME 401, proving the auth gate is on
     * the endpoint and runs before any board lookup — the credential is an employer-issued Job
     * Board API key an applicant cannot hold. GET on the same board is fully public, which is why
     * plan-building and dry-run looked healthy while submission was structurally impossible.
     * `apply_audit` recorded 0 successes for exactly this reason.
     */
    for (const url of [
      'https://boards.greenhouse.io/acme/jobs/12345',
      'https://job-boards.greenhouse.io/postman/jobs/7824502003',
    ]) {
      expect(identifySubmissionStrategy(url).strategy).toBe('browser');
    }
  });

  it('no posting is ever offered a direct-submit action', () => {
    // The UI must not print "Auto-apply" anywhere while no portal can actually submit.
    const urls = [
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.ashbyhq.com/acme/2cf6b8af-4bc3-4faf-a41b-390a3ebeaa8d',
      'https://careers.acme.com/apply/1',
      'https://jobs.lever.co/acme/x',
    ];
    for (const u of urls) {
      const s = identifySubmissionStrategy(u).strategy;
      expect(submitsDirectly(s)).toBe(false);
      expect(strategyActionLabel(s)).not.toBe('Auto-apply');
    }
  });

  it('Ashby routes to browser autofill, not direct submit', () => {
    /**
     * Ashby stopped inlining the application form schema in the page and now gates submission
     * behind reCAPTCHA — verified across six distinct company boards (Nabla, Grow Therapy, insitro,
     * Headway, Commure, Render): 6/6 had no `"sections":[` blob and 6/6 carried a recaptcha site
     * key. Claiming direct submit here would fail on every single Ashby job (~18% of the corpus).
     */
    for (const url of [
      'https://jobs.ashbyhq.com/grow-therapy/2cf6b8af-4bc3-4faf-a41b-390a3ebeaa8d',
      'https://acme.ashbyhq.com/2cf6b8af-4bc3-4faf-a41b-390a3ebeaa8d',
    ]) {
      expect(identifySubmissionStrategy(url).strategy).toBe('browser');
    }
    expect(submitsDirectly('browser')).toBe(false);
    expect(strategyActionLabel('browser')).toBe('Open & autofill');
  });

  it('Lever is manual — no submitter module has ever existed for it', () => {
    for (const url of [
      'https://jobs.lever.co/acme/abc-123',
    ]) {
      const m = identifySubmissionStrategy(url);
      expect(m.strategy).toBe('manual');
      expect(submitsDirectly(m.strategy)).toBe(false);
      expect(strategyActionLabel(m.strategy)).toBe('Apply on company site');
    }
  });

  it('LinkedIn job URLs route to the LinkedIn adapter, which never auto-submits', () => {
    for (const url of [
      'https://www.linkedin.com/jobs/view/4459868269',
      'https://www.linkedin.com/jobs/4459868269',
    ]) {
      const m = identifySubmissionStrategy(url);
      expect(m.strategy).toBe('linkedin');
      expect(m.linkedin?.jobId).toBe('4459868269');
      // The adapter fills the form and STOPS before the final Submit — the user clicks it.
      expect(submitsDirectly(m.strategy)).toBe(false);
      expect(strategyActionLabel(m.strategy)).not.toBe('Auto-apply');
    }
  });

  it('Naukri job URLs route to the Naukri adapter, which never auto-submits', () => {
    const url = 'https://www.naukri.com/job-listings-data-engineer-hyderabad-0-5-years-123456789';
    const m = identifySubmissionStrategy(url);
    expect(m.strategy).toBe('naukri');
    expect(submitsDirectly(m.strategy)).toBe(false);
    expect(strategyActionLabel(m.strategy)).not.toBe('Auto-apply');
  });

  it('login-walled / bot-protected boards are manual', () => {
    for (const url of [
      'https://www.indeed.com/viewjob?jk=abc',
      'https://www.glassdoor.com/job-listing/xyz',
    ]) {
      expect(identifySubmissionStrategy(url).strategy).toBe('manual');
    }
  });

  it('an unknown ATS gets the autofill assistant', () => {
    expect(identifySubmissionStrategy('https://careers.acme.com/apply/123').strategy).toBe('browser');
  });

  it('an empty URL is manual, never a promise', () => {
    expect(identifySubmissionStrategy('').strategy).toBe('manual');
  });

  it('`submitsDirectly` still describes the two API strategies, which are both disabled upstream', () => {
    // The predicate is unchanged — it says what those strategies WOULD do. What changed is that the
    // router no longer returns either of them, so nothing reaches a direct-submit path.
    // LinkedIn and Naukri adapters STOP before the final Submit, so they are not "direct" either.
    const all: SubmissionStrategy[] = ['greenhouse', 'ashby', 'linkedin', 'naukri', 'browser', 'manual'];
    expect(all.filter(submitsDirectly)).toEqual(['greenhouse', 'ashby']);
  });
});

describe('the autofill target is the page that has the form', () => {
  /**
   * REGRESSION: the assistant navigated to the JOB URL. On Ashby that is a description page with
   * ZERO fillable inputs — measured live: bare URL 0 inputs, `/application` 8-16 — so the user got
   * a browser window with nothing filled and no explanation.
   */
  it('appends /application for Ashby', () => {
    expect(applicationUrl('https://jobs.ashbyhq.com/temporal/5fb4393c'))
      .toBe('https://jobs.ashbyhq.com/temporal/5fb4393c/application');
  });

  it('is idempotent — never doubles the segment', () => {
    const once = applicationUrl('https://jobs.ashbyhq.com/acme/abc/application');
    expect(once).toBe('https://jobs.ashbyhq.com/acme/abc/application');
    expect(applicationUrl(once)).toBe(once);
  });

  it('preserves a query string', () => {
    expect(applicationUrl('https://jobs.ashbyhq.com/acme?ashby_jid=abc'))
      .toBe('https://jobs.ashbyhq.com/acme/application?ashby_jid=abc');
  });

  it('leaves Greenhouse alone (its job page renders the form inline)', () => {
    const gh = 'https://job-boards.greenhouse.io/natera/jobs/6157660004';
    expect(applicationUrl(gh)).toBe(gh);
  });

  it('leaves unknown URLs untouched', () => {
    expect(applicationUrl('https://careers.acme.com/apply/1')).toBe('https://careers.acme.com/apply/1');
    expect(applicationUrl('')).toBe('');
  });
});

describe('description-only aggregators are not offered autofill', () => {
  it('routes boards with no application form to manual', () => {
    for (const url of [
      'https://himalayas.app/companies/clario/jobs/lead-pm',
      'https://www.hirist.tech/j/some-job-1663899',
      'https://news.ycombinator.com/item?id=123',
      'https://remoteok.com/remote-jobs/123',
    ]) {
      expect(identifySubmissionStrategy(url).strategy).toBe('manual');
    }
  });
});
