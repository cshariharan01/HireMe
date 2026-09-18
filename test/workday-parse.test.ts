import { describe, it, expect } from 'vitest';
import { parseWorkdaySlug } from '@/lib/discovery/ats-detect';
import { identifySubmissionStrategy } from '@/lib/apply/router';

/**
 * Workday support is URL-ONLY, and this is why the parsing has to be exact.
 *
 * A pull needs three separate things — tenant, data-centre host (wd1/wd3/wd5…) and site name — and
 * NONE can be derived from a company name. Probing 15 plausible tenant/site pairs for Kaiser, HCA,
 * Providence, Cigna and Elevance returned zero working boards (422 = real tenant + wrong site,
 * 404 = wrong tenant, 500 on the human page = wrong both). So the only reliable source is the URL
 * a user pastes from the company's careers page, and mis-parsing it silently yields an empty board.
 */
describe('parseWorkdaySlug', () => {
  it('parses the plain form', () => {
    expect(parseWorkdaySlug('acme.wd1.myworkdayjobs.com/External')).toEqual({
      host: 'acme.wd1.myworkdayjobs.com',
      tenant: 'acme',
      site: 'External',
    });
  });

  it('drops the locale segment — the JSON endpoint is locale-free', () => {
    expect(parseWorkdaySlug('acme.wd5.myworkdayjobs.com/en-US/Careers_Site')).toEqual({
      host: 'acme.wd5.myworkdayjobs.com',
      tenant: 'acme',
      site: 'Careers_Site',
    });
  });

  it('tolerates a scheme and a trailing path', () => {
    expect(parseWorkdaySlug('https://big-health.wd3.myworkdayjobs.com/HCA/job/12345')).toEqual({
      host: 'big-health.wd3.myworkdayjobs.com',
      tenant: 'big-health',
      site: 'HCA',
    });
  });

  it('keeps hyphens in the tenant and underscores in the site', () => {
    const r = parseWorkdaySlug('mass-general.wd1.myworkdayjobs.com/MGB_External');
    expect(r?.tenant).toBe('mass-general');
    expect(r?.site).toBe('MGB_External');
  });

  it('rejects anything that is not a Workday board URL', () => {
    for (const bad of [
      '',
      'acme',
      'acme.myworkdayjobs.com/External',          // missing the data-centre segment
      'acme.wd1.myworkdayjobs.com',               // no site
      'boards.greenhouse.io/acme/jobs/1',
      'https://careers.acme.com/jobs',
    ]) {
      expect(parseWorkdaySlug(bad), bad).toBeNull();
    }
  });
});

describe('Workday postings are apply-manual, not autofill', () => {
  /** Workday's application flow is account-gated, so the autofill assistant cannot help. */
  it('does not offer an autofill action for a Workday job URL', () => {
    const { strategy } = identifySubmissionStrategy('https://acme.wd1.myworkdayjobs.com/External/job/123');
    // Whatever it resolves to, it must never claim a direct submit.
    expect(['browser', 'manual']).toContain(strategy);
  });
});
