import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveLinkedInQuestionAnswerAsync, resolveLinkedInQuestionAnswer } from '@/lib/apply/linkedin';
import { resolveScreeningQuestionWithGemini } from '@/lib/apply/llm-screening';
import type { CandidateProfile } from '@/lib/apply/platform';
import fs from 'fs';
import path from 'path';

describe('Gemini LLM Screening Question Resolution', () => {
  const profile: CandidateProfile = {
    name: 'Shariharan C',
    email: 'cshariharan01@gmail.com',
    yearsOfExperience: 3,
    yearsExperience: 3,
    noticePeriodDays: 30,
    currentCtcInr: 700000,
    expectedCtcInr: 1200000,
    city: 'Madurai',
    state: 'Tamil Nadu',
    country: 'India',
    skills: ['Python', 'Databricks', 'SQL', 'Airflow', 'Azure'],
  };

  it('uses deterministic rules for standard fields (Experience, Notice, CTC)', async () => {
    const expAns = await resolveLinkedInQuestionAnswerAsync('Total experience ?*', 'text', profile);
    expect(expAns).toBe('3');

    const noticeAns = await resolveLinkedInQuestionAnswerAsync('Notice period (days)', 'text', profile);
    expect(noticeAns).toBe('30');

    const ctcAns = await resolveLinkedInQuestionAnswerAsync('Current CTC ?*', 'text', profile);
    expect(ctcAns).toBe('700000');
  });

  it('falls back safely to heuristic answer if Gemini API key is not present', async () => {
    delete process.env.GEMINI_API_KEY;
    const ans = await resolveLinkedInQuestionAnswerAsync('How many Databricks pipelines have you built?*', 'text', profile);
    expect(ans).toBe('3');
  });

  it('caches generated answers to disk in data/screening-answers.json', async () => {
    const cachePath = path.join(process.cwd(), 'data', 'screening-answers.json');
    
    // Write a test entry directly to cache
    const testKey = 'are you open to relocate to bangalore?*::cshariharan01@gmail.com';
    let cacheContent: Record<string, string> = {};
    try {
      if (fs.existsSync(cachePath)) {
        cacheContent = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      }
    } catch {
      cacheContent = {};
    }

    cacheContent[testKey] = 'Yes, I am open to relocating to Bangalore.';
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cacheContent, null, 2), 'utf-8');

    const result = await resolveScreeningQuestionWithGemini(
      'Are you open to relocate to Bangalore?*',
      'text',
      [],
      profile
    );

    expect(result).toBe('Yes, I am open to relocating to Bangalore.');
  });
});
