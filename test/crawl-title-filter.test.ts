import { describe, it, expect } from 'vitest';
import { looksLikeJobTitle } from '@/lib/discovery/crawl';

/**
 * REGRESSION: the careers-page crawl must not inject nav links and marketing copy as "jobs".
 *
 * This became load-bearing after the SmartRecruiters detection fix. That probe answers HTTP 200 for
 * ANY slug, so `detectAts` used to report `smartrecruiters` for every company without a real ATS —
 * which meant an ATS was always "detected" and this crawl almost never ran. Requiring non-empty
 * postings fixed the detection, and in doing so opened the crawl path for exactly the big corporate
 * careers sites that produce junk.
 *
 * Every rejected string below was scraped from a REAL site during that testing:
 *   Epic     -> "Software Development", "Culinary"
 *   Mayo     -> "Excellence", "job"
 *   Availity -> "If it always feels like work, you're doing it wrong."
 * Before the filter those 29 strings would have entered the corpus as job postings.
 */
describe('crawl title filter', () => {
  it('rejects the exact junk observed on real careers sites', () => {
    for (const junk of [
      'Software Development',          // Epic — a category link
      'Culinary',                      // Epic
      'Excellence',                    // Mayo
      'job',                           // Mayo
      "If it always feels like work, you're doing it wrong.", // Availity marketing copy
    ]) {
      expect(looksLikeJobTitle(junk), junk).toBe(false);
    }
  });

  it('rejects nav and CTA labels', () => {
    for (const nav of [
      'Apply now', 'Search jobs', 'View all openings', 'Life at Acme',
      'Why work here', 'Benefits and perks', 'Sign in', 'Create an account',
      'Our team', 'Diversity and inclusion',
    ]) {
      expect(looksLikeJobTitle(nav), nav).toBe(false);
    }
  });

  it('rejects single words and absurd lengths', () => {
    expect(looksLikeJobTitle('Engineering')).toBe(false); // one word = a category
    expect(looksLikeJobTitle('Eng')).toBe(false);
    expect(looksLikeJobTitle('x'.repeat(200))).toBe(false);
    expect(looksLikeJobTitle('')).toBe(false);
  });

  it('keeps real postings, including the ones the crawl recovered from Epic', () => {
    for (const real of [
      'Software Development Internship',
      'Technical Solutions Engineering',
      'Senior Solutions Architect',
      'FHIR / Interoperability Architect',
      'Staff Software Engineer, Platform',
      'Principal Data Scientist',
      'Registered Nurse - ICU',
      'Clinical Terminologist',
      'Senior Actuary, Outcomes',
      'Claims Auditor',
      'DevOps Engineer (Remote)',
    ]) {
      expect(looksLikeJobTitle(real), real).toBe(true);
    }
  });

  it('is conservative — a false reject costs one job, a false accept pollutes ranking', () => {
    // Titles that are unusual but unmistakably postings must survive.
    expect(looksLikeJobTitle('Head of Data Platform')).toBe(true);
    expect(looksLikeJobTitle('VP, Product Security')).toBe(true);
  });
});
