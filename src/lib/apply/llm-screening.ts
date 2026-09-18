import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { CandidateProfile } from './platform';
import db from '../db';
import { primaryGenerate } from '../llm';

const CACHE_FILE_PATH = path.join(process.cwd(), 'data', 'screening-answers.json');

// Memory cache backed by data/screening-answers.json
let screeningCache: Record<string, string> | null = null;

function hashQuestion(q: string): string {
  const norm = q.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(norm).digest('hex').slice(0, 24);
}

function getStoredAnswerFromDb(questionText: string): string | null {
  try {
    const qHash = hashQuestion(questionText);
    const normQ = questionText.trim().toLowerCase();
    const row = db.prepare(`
      SELECT answer FROM screening_answers
      WHERE question_hash = ? OR lower(question) = ?
      ORDER BY last_used_at DESC LIMIT 1
    `).get(qHash, normQ) as { answer: string } | undefined;
    if (row?.answer && row.answer.trim()) return row.answer.trim();
  } catch {
    // ignore DB error
  }
  return null;
}

function saveAnswerToDb(questionText: string, answerText: string, category: string = 'llm'): void {
  try {
    const qHash = hashQuestion(questionText);
    db.prepare(`
      INSERT INTO screening_answers (question_hash, question, answer, category, used_count, last_used_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(question_hash) DO UPDATE SET
        answer = excluded.answer,
        used_count = used_count + 1,
        last_used_at = CURRENT_TIMESTAMP
    `).run(qHash, questionText.trim(), answerText.trim(), category);
  } catch (err) {
    console.warn('[llm-screening] Failed to save answer to DB:', err);
  }
}

function loadCache(): Record<string, string> {
  if (screeningCache) return screeningCache;
  try {
    if (fs.existsSync(CACHE_FILE_PATH)) {
      const content = fs.readFileSync(CACHE_FILE_PATH, 'utf-8');
      screeningCache = JSON.parse(content);
      return screeningCache!;
    }
  } catch {
    // ignore read error
  }
  screeningCache = {};
  return screeningCache;
}

function saveCache(cache: Record<string, string>) {
  try {
    const dir = path.dirname(CACHE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[llm-screening] Failed to save answer cache:', err);
  }
}

/**
 * Uses LLM (primaryGenerate) to resolve custom, qualitative, or multiline screening questions.
 * Works with ANY configured provider (Gemini, Freeway, OpenAI, Groq, Anthropic, Ollama).
 * Checks SQLite screening_answers database FIRST (respecting user edits made in /settings).
 */
export async function resolveScreeningQuestionWithGemini(
  label: string,
  inputType: string = 'text',
  options: string[] = [],
  profile: CandidateProfile = {}
): Promise<string | null> {
  const normLabel = label.trim();
  if (!normLabel) return null;

  // 1. Check user-configured / edited answers in database table `screening_answers`
  const dbAnswer = getStoredAnswerFromDb(normLabel);
  if (dbAnswer) {
    if (options.length > 0) {
      const matchedOpt = options.find((o) => o.trim().toLowerCase() === dbAnswer.toLowerCase())
        || options.find((o) => o.toLowerCase().includes(dbAnswer.toLowerCase()));
      if (matchedOpt) return matchedOpt.trim();
    } else {
      return dbAnswer;
    }
  }

  // 2. Check JSON disk cache
  const profileId = profile.email || profile.name || 'default';
  const cacheKey = `${normLabel.toLowerCase()}::${profileId}`;

  const cache = loadCache();
  if (cache[cacheKey]) {
    const cachedAns = cache[cacheKey];
    if (options.length > 0) {
      const matchedOpt = options.find((o) => o.trim().toLowerCase() === cachedAns.toLowerCase())
        || options.find((o) => o.toLowerCase().includes(cachedAns.toLowerCase()));
      if (matchedOpt) return matchedOpt.trim();
    } else {
      return cachedAns;
    }
  }

  // 3. Fallback to LLM Generation via primaryGenerate
  try {
    const profileSummary = {
      name: profile.name || 'Candidate',
      yearsExperience: profile.yearsOfExperience ?? profile.yearsExperience ?? null,
      noticePeriodDays: profile.noticePeriodDays ?? null,
      currentCtcInr: profile.currentCtcInr ?? null,
      expectedCtcInr: profile.expectedCtcInr ?? null,
      city: profile.city || profile.location || null,
      state: profile.state || null,
      country: profile.country || null,
      skills: profile.skills || [],
      education: profile.education || null,
      currentCompany: profile.currentCompany || null,
      currentJobTitle: profile.currentJobTitle || null,
      linkedin: profile.linkedinUrl || profile.linkedin || null,
      github: profile.githubUrl || profile.github || null,
      portfolioUrl: profile.portfolioUrl || null,
      summary: profile.summary || profile.bio || null,
    };

    let prompt = `You are assisting a job candidate with answering a screening question on a job application.
Answer truthfully, professionally, and directly on behalf of the candidate based on their profile.

Candidate Profile:
${JSON.stringify(profileSummary, null, 2)}

Screening Question: "${normLabel}"
Input Field Type: ${inputType}
`;

    if (options.length > 0) {
      prompt += `\nAvailable Choice Options (You MUST pick the single exact string from this list that best matches):
${options.map((o) => `- ${o}`).join('\n')}

Respond ONLY with the exact choice string from the list. Do not add markdown or extra explanation.`;
    } else if (inputType === 'textarea' || /describe|explain|detail|project|experience|tell us|example/i.test(normLabel)) {
      prompt += `\nThis is a multiline open-ended question. Provide a well-structured, 2-4 sentence response using first-person "I" (e.g. "I built a PySpark pipeline on Databricks..."). Do not use markdown headers or filler preamble.`;
    } else {
      prompt += `\nProvide a concise, direct answer (e.g. a number, Yes/No, or a single brief sentence). No markdown formatting or filler preamble.`;
    }

    const res = await primaryGenerate(prompt);
    let responseText = typeof res === 'string' ? res.trim() : '';

    // Clean up response
    responseText = responseText.replace(/^["'`]|["'`]$/g, '').trim();

    if (options.length > 0 && responseText) {
      const matched = options.find((o) => o.trim().toLowerCase() === responseText.toLowerCase())
        || options.find((o) => o.toLowerCase().includes(responseText.toLowerCase()))
        || options.find((o) => responseText.toLowerCase().includes(o.toLowerCase()))
        || options[0];
      responseText = matched.trim();
    }

    if (responseText) {
      // Save to both SQLite DB (so it shows in /settings) and JSON cache
      saveAnswerToDb(normLabel, responseText);
      cache[cacheKey] = responseText;
      saveCache(cache);
      return responseText;
    }
  } catch (e) {
    console.warn('[llm-screening] LLM resolution failed:', e instanceof Error ? e.message : e);
  }

  return null;
}
