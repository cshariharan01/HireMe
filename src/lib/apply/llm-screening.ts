import fs from 'fs';
import path from 'path';
import type { CandidateProfile } from './platform';
import db from '../db';
import { primaryGenerate } from '../llm';
import { screeningOwnerId, hashScreeningQuestion, ensureScreeningOwner } from './screening-owner';

// Overridable for tests so suites never touch the real data dir.
function cacheFilePath(): string {
  return process.env.SCREENING_CACHE_PATH || path.join(process.cwd(), 'data', 'screening-answers.json');
}

// Memory cache backed by the JSON file (keyed per-profile by email — see below).
let screeningCache: Record<string, string> | null = null;
let screeningCachePath: string | null = null;

/** Test-only: drop the memoized JSON cache (e.g. after re-pointing the path). */
export function __resetScreeningCache(): void {
  screeningCache = null;
  screeningCachePath = null;
}

function getStoredAnswerFromDb(questionText: string, ownerId: string): string | null {
  try {
    const qHash = hashScreeningQuestion(questionText, ownerId);
    const row = db.prepare(`
      SELECT answer FROM screening_answers
      WHERE question_hash = ?
      ORDER BY last_used_at DESC LIMIT 1
    `).get(qHash) as { answer: string } | undefined;
    if (row?.answer && row.answer.trim()) return row.answer.trim();
  } catch {
    // ignore DB error
  }
  return null;
}

function saveAnswerToDb(questionText: string, answerText: string, ownerId: string, category: string = 'llm'): void {
  try {
    const q = questionText.trim().toLowerCase();
    const a = answerText.trim().toLowerCase();
    // Never persist nonsensical answers (e.g. question echoed as answer, or default HTML radio/checkbox value 'on')
    if (!q || !a || q === a || a === 'on') {
      return;
    }

    const qHash = hashScreeningQuestion(questionText, ownerId);
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
  const cachePath = cacheFilePath();
  if (screeningCache && screeningCachePath === cachePath) return screeningCache;
  try {
    if (fs.existsSync(cachePath)) {
      const content = fs.readFileSync(cachePath, 'utf-8');
      screeningCache = JSON.parse(content);
      screeningCachePath = cachePath;
      return screeningCache!;
    }
  } catch {
    // ignore read error
  }
  screeningCache = {};
  screeningCachePath = cachePath;
  return screeningCache;
}

function saveCache(cache: Record<string, string>) {
  try {
    const cachePath = cacheFilePath();
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[llm-screening] Failed to save answer cache:', err);
  }
}

export interface FieldConstraints {
  inputMode?: string;
  pattern?: string;
  maxLength?: number;
  isNumeric?: boolean;
  errorMessage?: string;
}

/**
 * Uses LLM (primaryGenerate) to resolve custom, qualitative, or multiline screening questions.
 * Works with ANY configured provider (Gemini, Freeway, OpenAI, Groq, Anthropic, Ollama).
 * Checks the profile-scoped SQLite screening_answers cache FIRST.
 */
export async function resolveScreeningQuestionWithGemini(
  label: string,
  inputType: string = 'text',
  options: string[] = [],
  profile: CandidateProfile = {},
  constraints: FieldConstraints = {}
): Promise<string | null> {
  const normLabel = label.trim();
  if (!normLabel) return null;

  // Profile-scoped cache: a new user (different email/name) never sees the
  // previous owner's stored answers, and the previous owner's rows are wiped.
  const ownerId = screeningOwnerId(profile as Record<string, unknown>);
  ensureScreeningOwner(ownerId);

  // 1. Check user-configured / edited answers in database table `screening_answers`
  const dbAnswer = getStoredAnswerFromDb(normLabel, ownerId);
  if (dbAnswer && !constraints.errorMessage) {
    if (options.length > 0) {
      const matchedOpt = options.find((o) => o.trim().toLowerCase() === dbAnswer.toLowerCase())
        || options.find((o) => o.toLowerCase().includes(dbAnswer.toLowerCase()));
      if (matchedOpt) return matchedOpt.trim();
    } else {
      return dbAnswer;
    }
  }

  // 2. Check JSON disk cache (also per-profile: key includes the owner id)
  const cacheKey = `${normLabel.toLowerCase()}::${ownerId}`;

  const cache = loadCache();
  if (cache[cacheKey] && !constraints.errorMessage) {
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
      preferredLocations: (profile.targets as { locations?: string[] })?.locations
        || (Array.isArray(profile.targetLocations) ? profile.targetLocations : [])
        || (Array.isArray(profile.targets) ? profile.targets : []),
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
Answer truthfully, professionally, and directly on behalf of the candidate based on their profile facts and the field constraints.

Candidate Profile:
${JSON.stringify(profileSummary, null, 2)}

Screening Question: "${normLabel}"
Input Field Type: ${inputType}
`;

    const isNumericQuestion =
      Boolean(constraints.isNumeric) ||
      constraints.inputMode === 'numeric' ||
      Boolean(constraints.pattern?.includes('0-9')) ||
      Boolean(constraints.pattern?.includes('\\d')) ||
      /(?:how many|total|relevant|overall)?\s*years(?:\s+of)?(?:\s+experience|\s+exp)?\b|years in\b|\byoe\b|how many\s+(?:years|months|days|projects|people|teams|clients)\b/i.test(normLabel);

    if (isNumericQuestion) {
      prompt += `\nFIELD CONSTRAINT: NUMERIC ONLY. The question is asking for a numeric count or number of years. Output ONLY pure digits (e.g. 3, or notice period days like 30, or CTC amount like 700000). DO NOT output text like "Yes", "No", "3 years", or "30 days". Output ONLY digits.`;
    }
    if (constraints.maxLength && constraints.maxLength > 0) {
      prompt += `\nFIELD CONSTRAINT: MAX LENGTH ${constraints.maxLength} characters.`;
    }
    if (constraints.errorMessage) {
      prompt += `\nPREVIOUS ATTEMPT VALIDATION ERROR: "${constraints.errorMessage}". Adjust your format so it strictly complies with the input validator.`;
    }

    if (options.length > 0) {
      prompt += `\nAvailable Choice Options (Pick the single exact string from this list that best matches):
${options.map((o) => `- ${o}`).join('\n')}

Respond ONLY with the exact choice string from the list. Do not add markdown or extra explanation.`;
    } else if (isNumericQuestion) {
      prompt += `\nRespond with ONLY the exact numeric value (e.g. "3" or "30"). No words, no units, no markdown.`;
    } else if ((inputType === 'textarea' || /describe|explain|detail|project|experience|tell us|example/i.test(normLabel)) && !isNumericQuestion) {
      prompt += `\nThis is a multiline open-ended question. Provide a well-structured, 2-4 sentence response using first-person "I". Do not use markdown headers or filler preamble.`;
    } else {
      prompt += `\nProvide a concise, direct answer (e.g. a number, Yes/No, or a single brief sentence). No markdown formatting or filler preamble.`;
    }

    const res = await primaryGenerate(prompt);
    let responseText = typeof res === 'string' ? res.trim() : '';

    // Clean up response
    responseText = responseText.replace(/^["'`]|["'`]$/g, '').trim();

    if (isNumericQuestion && !/^\d+$/.test(responseText)) {
      const digitsMatch = responseText.match(/\d+/);
      if (digitsMatch) {
        responseText = digitsMatch[0];
      } else {
        const yoe = profileSummary.yearsExperience;
        responseText = yoe !== null && yoe !== undefined ? String(Math.floor(Number(yoe))) : '3';
      }
    }

    if (options.length > 0) {
      const validOptions = options.filter((o) => o && !/^(?:select|choose|please\s*select|--|\s*)$/i.test(o.trim()));
      const pool = validOptions.length > 0 ? validOptions : options;

      if (responseText && responseText.toLowerCase() !== normLabel.toLowerCase()) {
        const matched = pool.find((o) => o.trim().toLowerCase() === responseText.toLowerCase())
          || pool.find((o) => o.toLowerCase().includes(responseText.toLowerCase()))
          || pool.find((o) => responseText.toLowerCase().includes(o.toLowerCase()));
        if (matched) {
          responseText = matched.trim();
        } else {
          // If responseText didn't match, pick first valid non-placeholder option
          responseText = pool[0].trim();
        }
      } else {
        responseText = pool[0]?.trim() || '';
      }
    }

    if (responseText && responseText.toLowerCase() !== normLabel.toLowerCase()) {
      // Save to both SQLite DB and the per-profile JSON cache, so the NEXT
      // application by THIS user reuses it without another LLM call.
      saveAnswerToDb(normLabel, responseText, ownerId);
      cache[cacheKey] = responseText;
      saveCache(cache);
      return responseText;
    }
  } catch (e) {
    console.warn('[llm-screening] LLM resolution failed:', e instanceof Error ? e.message : e);
  }

  return null;
}
