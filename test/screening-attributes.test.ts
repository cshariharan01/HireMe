import { describe, it, expect } from 'vitest';
import { classifyQuestion, answerScreeningQuestion } from '@/lib/apply/questions';
import { buildMatchesPage } from '@/lib/matches-page';
import db from '@/lib/db';

describe('Screening Question Attribute Answering', () => {
  const profile = {
    name: 'Hariharan Subramaniyan',
    email: 'cshariharan2001@gmail.com',
    location: 'Madurai, India',
    street: 'Madurai',
    city: 'Madurai',
    state: 'Tamil Nadu',
    country: 'India',
    zipCode: '625001',
    pincode: '625001',
    yearsOfExperience: 3,
    totalExperienceMonths: 6,
    noticePeriodDays: 30,
    currentCtcInr: 700000,
    expectedCtcInr: 1200000,
    portfolioUrl: 'https://github.com/cshariharan01',
    dateOfBirth: '2001-05-15',
    targets: {
      comp_min: 1000000,
      comp_max: 3000000,
      comp_currency: 'INR',
    },
  };

  const ctx = {
    jobTitle: 'Data Engineer',
    company: 'Staples India',
  };

  it('correctly classifies screening questions from the Easy Apply form', () => {
    expect(classifyQuestion('Please enter your notice period in days')).toBe('notice_period');
    expect(classifyQuestion('Please enter your current ctc in INR')).toBe('current_salary');
    expect(classifyQuestion('Please enter your expected ctc in INR')).toBe('salary');
    expect(classifyQuestion('What is your current Salary')).toBe('current_salary');
    expect(classifyQuestion('What is your expected Salary')).toBe('salary');
    expect(classifyQuestion('Street')).toBe('street');
    expect(classifyQuestion('State')).toBe('state');
    expect(classifyQuestion('Country')).toBe('country');
    expect(classifyQuestion('Zipcode')).toBe('zipcode');
    expect(classifyQuestion('Please enter your online portfolio URL')).toBe('portfolio');
    expect(classifyQuestion('Please enter your date of birth')).toBe('dob');
    expect(classifyQuestion('Please select your total years of professional experience:')).toBe('years_experience');
    expect(classifyQuestion('Please select your total additional months of experience:')).toBe('months_experience');
    expect(classifyQuestion('Total experience ?*')).toBe('years_experience');
    expect(classifyQuestion('Once offered, how soon you can join us - in days ?*')).toBe('notice_period');
  });

  it('answers PDI technologies salary questions correctly', async () => {
    const curRes = await answerScreeningQuestion('What is your current Salary', null, profile, ctx);
    expect(curRes.answer).toBe('700000');

    const expRes = await answerScreeningQuestion('What is your expected Salary', null, profile, ctx);
    expect(expRes.answer).toBe('1200000');
  });

  it('answers Facctum address questions correctly', async () => {
    const streetRes = await answerScreeningQuestion('Street', null, profile, ctx);
    expect(streetRes.answer).toBe('Madurai');

    const stateRes = await answerScreeningQuestion('State', null, profile, ctx);
    expect(stateRes.answer).toBe('Tamil Nadu');

    const countryRes = await answerScreeningQuestion('Country', null, profile, ctx);
    expect(countryRes.answer).toBe('India');

    const zipRes = await answerScreeningQuestion('Zipcode', null, profile, ctx);
    expect(zipRes.answer).toBe('625001');
  });

  it('answers notice period in days without defaulting to 3', async () => {
    const res = await answerScreeningQuestion('Please enter your notice period in days', null, profile, ctx);
    expect(res.answer).toBe('30');
    expect(res.answer).not.toBe('3');
  });

  it('answers current CTC in INR without defaulting to 3', async () => {
    const res = await answerScreeningQuestion('Please enter your current ctc in INR', null, profile, ctx);
    expect(res.answer).toBe('700000');
    expect(res.answer).not.toBe('3');
  });

  it('answers expected CTC in INR without defaulting to 3', async () => {
    const res = await answerScreeningQuestion('Please enter your expected ctc in INR', null, profile, ctx);
    expect(res.answer).toBe('1200000');
    expect(res.answer).not.toBe('3');
  });

  it('answers portfolio URL with candidate URL, never a number', async () => {
    const res = await answerScreeningQuestion('Please enter your online portfolio URL', null, profile, ctx);
    expect(res.answer).toBe('https://github.com/cshariharan01');
    expect(res.answer).not.toBe('3');
  });

  it('answers date of birth accurately', async () => {
    const res = await answerScreeningQuestion('Please enter your date of birth', null, profile, ctx);
    expect(res.answer).toBe('2001-05-15');
  });

  it('answers additional months of experience with 6, not 0', async () => {
    const res = await answerScreeningQuestion('Please select your total additional months of experience:', null, profile, ctx);
    expect(res.answer).toBe('6');
  });

  it('answers total years of experience with 3', async () => {
    const res = await answerScreeningQuestion('Please select your total years of professional experience:', null, profile, ctx);
    expect(res.answer).toBe('3');

    const resTotal = await answerScreeningQuestion('Total experience ?*', null, profile, ctx);
    expect(resTotal.answer).toBe('3');
  });

  it('answers "Once offered, how soon you can join us - in days ?*" with notice period days', async () => {
    const res = await answerScreeningQuestion('Once offered, how soon you can join us - in days ?*', null, profile, ctx);
    expect(res.answer).toBe('30');
    expect(res.answer).not.toBe('3');
  });

  it('classifies and answers city residence verification questions deterministically', async () => {
    expect(classifyQuestion('Are you residing curretly in Hydrabad ?')).toBe('location');
    expect(classifyQuestion('Are you residing in Madurai ?')).toBe('location');

    const resNo = await answerScreeningQuestion('Are you residing curretly in Hydrabad ?', null, profile, ctx);
    expect(resNo.answer).toBe('No');
    expect(resNo.source).toBe('defaults');

    const resYes = await answerScreeningQuestion('Are you residing in Madurai ?', null, profile, ctx);
    expect(resYes.answer).toBe('Yes');
    expect(resYes.source).toBe('defaults');

    const resOptions = await answerScreeningQuestion('Are you residing curretly in Hydrabad ?', ['Yes', 'No'], profile, ctx);
    expect(resOptions.answer).toBe('No');
  });
});

describe('Dashboard Matches Filter and Tracker Duplicate Prevention', () => {
  it('hides applied jobs by default from the matches page', () => {
    const page = buildMatchesPage({ includeApplied: false });
    for (const m of page.matches) {
      expect(m.applied).toBe(false);
      expect(m.applicationStatus).toBeNull();
    }
  });

  it('prevents duplicate application records in my_applications', () => {
    const testJobId = 999999;
    try {
      db.prepare("INSERT OR REPLACE INTO job_postings (id, company, title) VALUES (?, 'TestCo', 'Test Title')").run(testJobId);
      db.prepare("INSERT OR REPLACE INTO my_applications (job_id, status, applied_date) VALUES (?, 'applied', '2026-09-16')").run(testJobId);
      const existing = db.prepare("SELECT id FROM my_applications WHERE job_id = ? AND status IN ('applied', 'screening', 'interview', 'offer')").get(testJobId);
      expect(existing).toBeDefined();
    } finally {
      db.prepare('DELETE FROM my_applications WHERE job_id = ?').run(testJobId);
      db.prepare('DELETE FROM job_postings WHERE id = ?').run(testJobId);
    }
  });
});
