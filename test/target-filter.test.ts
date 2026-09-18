import { describe, it, expect } from 'vitest';
import {
  isTargetDataRole,
  isSeniorityCompatible,
  matchesPreferredRole,
  isExperienceCompatible,
  isAutofillCapableUrl,
  isTargetLocation,
  isLocationCompatible,
} from '@/lib/target-job-filter';
import { extractPostingFacts } from '@/lib/posting-facts';
import { INDIA_LOCATIONS_REGEX } from '@/lib/matches';
import { getMatchPlatform } from '@/lib/matches-page';

describe('isTargetDataRole — Data Engineering focus', () => {
  it('accepts the explicit target roles', () => {
    for (const t of [
      'Data Engineer',
      'Senior Big Data Engineer',
      'ETL Developer',
      'Extract, Transform, Load Engineer',
      'Cloud Data Engineer',
      'Data Platform Engineer',
      'Lead Data Engineer',
    ]) {
      expect(isTargetDataRole(t), t).toBe(true);
    }
  });

  it('rejects adjacent non-target roles', () => {
    for (const t of [
      'Data Scientist',
      'Data Analyst',
      'Business Analyst',
      'BI Analyst',
      'Machine Learning Engineer',
      'ML Engineer',
      'AI Engineer',
      'Data Architect',
      'Database Administrator',
      'DBA',
      'DevOps Engineer',
      'Site Reliability Engineer',
      'SRE',
    ]) {
      expect(isTargetDataRole(t), t).toBe(false);
    }
  });

  it('rejects empty/undefined titles without throwing', () => {
    expect(isTargetDataRole('')).toBe(false);
    expect(isTargetDataRole(undefined as unknown as string)).toBe(false);
  });
});

describe('isSeniorityCompatible — candidate-agnostic and title-neutral', () => {
  it('does not artificially reject roles based on title keywords', () => {
    for (const t of [
      'Data Engineer',
      'Senior Data Engineer',
      'Lead Data Engineer',
      'Principal Data Engineer',
      'Staff Data Engineer',
      'Data Architect',
      'Data Engineering Manager',
      'Cloud Data Engineer',
    ]) {
      expect(isSeniorityCompatible(t), t).toBe(true);
    }
  });
});

describe('matchesPreferredRole — dynamic profile role matching', () => {
  const preferred = ['Cloud Data Engineer', 'Data Engineer', 'Big Data Engineer', 'ETL Developer'];

  it('matches preferred roles and variations', () => {
    expect(matchesPreferredRole('Senior Data Engineer', preferred)).toBe(true);
    expect(matchesPreferredRole('Lead Data Engineer', preferred)).toBe(true);
    expect(matchesPreferredRole('Cloud Data Engineer', preferred)).toBe(true);
    expect(matchesPreferredRole('Big Data Engineer', preferred)).toBe(true);
    expect(matchesPreferredRole('ETL Developer', preferred)).toBe(true);
  });

  it('rejects roles outside user preferences', () => {
    expect(matchesPreferredRole('Salesforce Admin', preferred)).toBe(false);
    expect(matchesPreferredRole('HR Specialist', preferred)).toBe(false);
  });

  it('allows all roles when user has no preferred roles configured', () => {
    expect(matchesPreferredRole('Any Role', [])).toBe(true);
  });
});

describe('isExperienceCompatible — dynamic experience matching', () => {
  it('accepts ranges that include the candidate experience', () => {
    expect(isExperienceCompatible(3, 5, '', 3.6)).toBe(true);
    expect(isExperienceCompatible(3, null, '', 3.6)).toBe(true);
  });

  it('rejects ranges that require more than candidate years', () => {
    expect(isExperienceCompatible(4, 7, '', 3.5)).toBe(false);
    expect(isExperienceCompatible(5, 8, '', 3.5)).toBe(false);
    // When a candidate has 6 years, 5-8 is accepted dynamically
    expect(isExperienceCompatible(5, 8, '', 6.0)).toBe(true);
    // min 5 -> too senior for default 3.6 years
    expect(isExperienceCompatible(5, 9)).toBe(false);
    expect(isExperienceCompatible(4, null)).toBe(false);
  });

  it('rejects clearly-junior ranges', () => {
    expect(isExperienceCompatible(0, 1)).toBe(false);
    expect(isExperienceCompatible(1, 2)).toBe(false);
  });

  it('parses text fallbacks', () => {
    expect(isExperienceCompatible(null, null, '2-4 years')).toBe(true);
    expect(isExperienceCompatible(null, null, '1-2 years')).toBe(false);
    expect(isExperienceCompatible(null, null, '5+ years')).toBe(false);
    expect(isExperienceCompatible(null, null, 'Minimum 3 years')).toBe(true);
    expect(isExperienceCompatible(null, null, 'No experience needed')).toBe(true);
  });

  it('parses Naukri URL slugs in fallback text', () => {
    expect(
      isExperienceCompatible(
        null,
        null,
        'https://www.naukri.com/job-listings-cloud-data-engineer-2-to-6-years-12345',
      ),
    ).toBe(true);
    expect(
      isExperienceCompatible(
        null,
        null,
        'https://www.naukri.com/job-listings-senior-consultant-lead-pyspark-cloud-data-engineer-8-to-12-years-250826922327',
      ),
    ).toBe(false);
    expect(
      isExperienceCompatible(
        null,
        null,
        'https://www.naukri.com/job-listings-cloud-data-engineer-12-to-15-years-999',
      ),
    ).toBe(false);
  });

  it('parses concatenated and en-dash strings in fallback text', () => {
    expect(isExperienceCompatible(null, null, 'Experience: 6–12 yearsLocation: Hyderabad')).toBe(false);
    expect(isExperienceCompatible(null, null, 'Requires 8 years of experience')).toBe(false);
    expect(isExperienceCompatible(null, null, 'Experience: 2–5 yearsLocation: Chennai')).toBe(true);
  });
});

describe('extractPostingFacts — experience extraction', () => {
  it('extracts experience from Naukri URL slugs', () => {
    const facts = extractPostingFacts(
      'Short desc',
      'Chennai',
      'Senior Consultant',
      'https://www.naukri.com/job-listings-senior-consultant-lead-pyspark-cloud-data-engineer-chennai-8-to-12-years-250826922327',
    );
    expect(facts.experienceMin).toBe(8);
    expect(facts.experienceMax).toBe(12);
    expect(facts.experienceText).toBe('8-12 yrs');
  });

  it('extracts experience from concatenated text with en-dash', () => {
    const facts = extractPostingFacts('Experience: 6–12 yearsLocation: Hyderabad');
    expect(facts.experienceMin).toBe(6);
    expect(facts.experienceMax).toBe(12);
    expect(facts.experienceText).toBe('6-12 yrs');
  });

  it('prioritizes explicit JD description experience over misleading URL slug', () => {
    // Real-world scenario: Naukri URL slug is 1-to-3-years, but employer explicitly specifies Minimum 4 years in JD text
    const facts = extractPostingFacts(
      'Role & responsibilities Experience: Minimum of 4 years of experience in data engineering roles with bachelors degree. Technical Skills: Databricks, Azure Data Factory.',
      'Hyderabad',
      'Data Engineer - Azure data factory',
      'https://www.naukri.com/job-listings-data-engineer-azure-data-factory-cloudxtreme-hyderabad-1-to-3-years-040926925542',
    );
    expect(facts.experienceMin).toBe(4);
    expect(facts.experienceMax).toBeNull();
    expect(facts.experienceText).toBe('4+ yrs');

    // For a candidate with 3.0 or 3.6 YOE, this role is properly rejected
    expect(isExperienceCompatible(facts.experienceMin, facts.experienceMax, '', 3.0)).toBe(false);
  });

  it('does not mistake application minutes or hours as years of experience', () => {
    const facts = extractPostingFacts(
      'Application Process (Takes 20-30 mins to complete). Must have 2+ years of professional DevOps experience.',
      'Remote',
      'Cloud Engineer',
      '',
    );
    expect(facts.experienceMin).toBe(2);
    expect(facts.experienceMax).toBeNull();
    expect(facts.experienceText).toBe('2+ yrs');
  });
});

describe('isAutofillCapableUrl', () => {
  it('accepts LinkedIn and Naukri job URLs only', () => {
    expect(isAutofillCapableUrl('https://www.linkedin.com/jobs/view/4459868269')).toBe(true);
    expect(isAutofillCapableUrl('https://www.naukri.com/job-listings-xyz')).toBe(true);
  });

  it('rejects external ATS and unsupported boards', () => {
    expect(isAutofillCapableUrl('https://boards.greenhouse.io/acme/jobs/123')).toBe(false);
    expect(isAutofillCapableUrl('https://jobs.ashbyhq.com/acme/abc')).toBe(false);
    expect(isAutofillCapableUrl('https://himalayas.app/companies/acme/jobs/lead')).toBe(false);
    expect(isAutofillCapableUrl('https://www.hirist.tech/j/123')).toBe(false);
    expect(isAutofillCapableUrl(null)).toBe(false);
    expect(isAutofillCapableUrl('')).toBe(false);
  });
});

describe('isTargetLocation — India + relevant remote', () => {
  it('accepts India cities', () => {
    for (const loc of ['Bengaluru, Karnataka, India', 'Hyderabad, India', 'Pune', 'Chennai']) {
      expect(isTargetLocation(loc, null), loc).toBe(true);
    }
  });

  it('accepts remote (non-US)', () => {
    expect(isTargetLocation('Remote', 'Remote')).toBe(true);
    expect(isTargetLocation('Remote - India', 'Remote')).toBe(true);
    expect(isTargetLocation('Remote', 'remote-global')).toBe(true);
  });

  it('rejects US-only remote', () => {
    expect(isTargetLocation('Remote - United States', 'Remote')).toBe(false);
    expect(isTargetLocation('San Francisco, CA', 'US city')).toBe(false);
  });

  it('rejects unrelated locations and remote-neutral', () => {
    expect(isTargetLocation('London, UK', null)).toBe(false);
    expect(isTargetLocation('London Area, United Kingdom', 'remote-neutral')).toBe(false);
    expect(isTargetLocation('Peru', 'remote-neutral')).toBe(false);
    expect(isTargetLocation('Istanbul, Türkiye', 'remote-neutral')).toBe(false);
    expect(isTargetLocation('', '')).toBe(false);
  });
});

describe('isLocationCompatible — dynamic preferred locations', () => {
  it('matches preferred locations when provided', () => {
    expect(isLocationCompatible('Bengaluru, India', null, ['India', 'Remote'])).toBe(true);
    expect(isLocationCompatible('Remote', 'remote-global', ['India', 'Remote'])).toBe(true);
    expect(isLocationCompatible('Berlin, Germany', null, ['Germany', 'Remote'])).toBe(true);
  });

  it('rejects locations not in candidate preferred locations', () => {
    expect(isLocationCompatible('London, UK', null, ['India', 'Remote'])).toBe(false);
    expect(isLocationCompatible('San Francisco, CA', null, ['India', 'Remote'])).toBe(false);
  });

  it('falls back to default target location when no preferences configured', () => {
    expect(isLocationCompatible('Hyderabad, India', null, [])).toBe(true);
    expect(isLocationCompatible('London, UK', null, [])).toBe(false);
  });
});

describe('INDIA_LOCATIONS_REGEX — comprehensive Indian city matching', () => {
  it('matches all major Indian tech hubs without requiring literal "india"', () => {
    const indianCities = [
      'Bengaluru',
      'Bengaluru, Karnataka',
      'Bangalore',
      '1401-GIPL: Prestige Technology Park IV, Bangalore',
      'Hyderabad',
      'Pune, Maharashtra',
      'Chennai',
      'Mumbai',
      'Noida',
      'Gurugram',
      'Gurgaon',
      'New Delhi',
      'Kolkata',
      'Ahmedabad',
    ];
    for (const city of indianCities) {
      expect(INDIA_LOCATIONS_REGEX.test(city), city).toBe(true);
    }
  });

  it('rejects foreign cities and generic remote strings without Indian locations', () => {
    const foreign = [
      'London, UK',
      'San Francisco, CA',
      'Seattle, WA',
      'Toronto, Ontario, Canada',
      'Berlin, Germany',
      'Remote',
      'Anywhere',
      'Worldwide',
    ];
    for (const place of foreign) {
      expect(INDIA_LOCATIONS_REGEX.test(place), place).toBe(false);
    }
  });
});

describe('getMatchPlatform — platform categorization', () => {
  it('correctly classifies LinkedIn jobs', () => {
    expect(getMatchPlatform({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/123' })).toBe('linkedin');
    expect(getMatchPlatform({ source: 'external', sourcePlatform: 'linkedin', url: 'https://job.url' })).toBe('linkedin');
  });

  it('correctly classifies Naukri jobs', () => {
    expect(getMatchPlatform({ source: 'naukri', url: 'https://www.naukri.com/job-listings-123' })).toBe('naukri');
    expect(getMatchPlatform({ source: 'external', sourcePlatform: 'naukri', url: 'https://job.url' })).toBe('naukri');
  });

  it('correctly classifies direct ATS platforms', () => {
    expect(getMatchPlatform({ source: 'greenhouse', url: 'https://boards.greenhouse.io/job/1' })).toBe('direct');
    expect(getMatchPlatform({ source: 'ashby', url: 'https://jobs.ashbyhq.com/company/job' })).toBe('direct');
    expect(getMatchPlatform({ source: 'company', url: 'https://careers.company.com/job' })).toBe('direct');
  });
});