// Screening-question answerer.
//
// Resolution order for each question:
//   1. Common-category lookup (work-auth, sponsorship, notice-period, salary, EEO, ...)
//      using regex match against the question text + defaults from apply_settings JSON
//   2. Exact-match lookup in screening_answers table (cached past answers)
//   3. LLM fallback via creative-lane primaryGenerate, then save to library
//
// Every answer flows back into the library so the second time we see the same
// question (across companies) we hit the cache.

import db from '../db';
import { primaryGenerate } from '../llm';
import { screeningOwnerId, hashScreeningQuestion, ensureScreeningOwner } from './screening-owner';

export type QuestionCategory =
  | 'work_auth'         // "Are you authorized to work in X?"
  | 'sponsorship'       // "Do you require visa sponsorship?"
  | 'notice_period'     // "What's your notice period?"
  | 'salary'            // "Expected compensation"
  | 'current_salary'    // "Current compensation"
  | 'street'            // Street address
  | 'state'             // State / province
  | 'country'           // Country
  | 'zipcode'           // Zip / postal code
  | 'why_company'       // "Why are you interested in [company]?"
  | 'years_experience'  // "Years of experience with X"
  | 'months_experience' // "Additional months of experience"
  | 'location'          // "What's your current location?"
  | 'start_date'        // "When can you start?"
  | 'portfolio'         // "Portfolio URL / Website / GitHub"
  | 'dob'               // "Date of birth"
  | 'eeo_race'          // EEO / diversity self-identification
  | 'eeo_gender'
  | 'eeo_veteran'
  | 'eeo_disability'
  | 'other';

export interface ApplyDefaults {
  // Common screening defaults set in /settings
  workAuth?: Record<string, 'yes' | 'no'>;     // country code → yes/no, e.g. {"US":"no","IN":"yes","UK":"no"}
  needsSponsorship?: 'yes' | 'no';
  noticePeriodDays?: number;                    // e.g. 30, 60, 90
  currentSalary?: string;                       // free-form, user can omit
  expectedSalary?: string;                      // falls back to profile.targets.comp_min..comp_max
  startDate?: string;                           // "Immediately" or ISO date
  portfolioUrl?: string;
  dateOfBirth?: string;
  // EEO defaults — defaulted to "prefer not to say" until user opts in
  eeoRace?: string;
  eeoGender?: string;
  eeoVeteran?: 'yes' | 'no' | 'prefer_not_to_say';
  eeoDisability?: 'yes' | 'no' | 'prefer_not_to_say';
}

export interface QuestionContext {
  jobTitle: string;
  company: string;
  jobDescription?: string;
  jobLocation?: string;
}

export interface AnswerResult {
  answer: string;
  category: QuestionCategory;
  source: 'cache' | 'defaults' | 'llm';
  questionHash: string;
}

// Question hashing is profile-scoped — see ./screening-owner. A hash written by one
// profile must never match a lookup from another, so a new user starts fresh instead
// of inheriting the previous owner's cached answers.

/**
 * Normalizes common Indian and international city names and aliases/typos.
 */
export function normalizeCityName(cityName: string): string {
  const c = cityName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^hyd(?:e?rabad)?$/i.test(c) || c === 'hyd') return 'hyderabad';
  if (/^b(?:angalore|engaluru|lr)$/i.test(c)) return 'bangalore';
  if (/^(?:chennai|madras)$/i.test(c) || c === 'maa') return 'chennai';
  if (/^(?:mumbai|bombay)$/i.test(c) || c === 'bombay' || c === 'mumbai') return 'mumbai';
  if (/^(?:kolkata|calcutta)$/i.test(c) || c === 'ccu') return 'kolkata';
  if (/^(?:gurgaon|gurugram)$/i.test(c)) return 'gurgaon';
  if (/^noida$/i.test(c)) return 'noida';
  if (/^(?:delhi|newdelhi|ncr)$/i.test(c)) return 'delhi';
  if (/^pune$/i.test(c) || c === 'pnq') return 'pune';
  if (/^madurai$/i.test(c) || c === 'ixm') return 'madurai';
  if (/^(?:coimbatore|kovai)$/i.test(c) || c === 'cjb') return 'coimbatore';
  if (/^(?:kochi|cochin)$/i.test(c) || c === 'cok') return 'kochi';
  if (/^(?:trivandrum|thiruvananthapuram)$/i.test(c)) return 'thiruvananthapuram';
  if (/^ahmedabad$/i.test(c) || c === 'amd') return 'ahmedabad';
  return c;
}

/**
 * Matches screening questions asking whether the candidate currently resides in a specific city/location.
 * Returns { isResidenceQuestion: true, answer: 'Yes' | 'No', targetCity: string } if matched, or null otherwise.
 */
export function matchCityResidenceQuestion(
  questionText: string,
  candidateLocation?: string,
): { isResidenceQuestion: boolean; answer: 'Yes' | 'No'; targetCity: string } | null {
  const q = questionText.trim();

  // 1. Open-ended questions asking for city name are NOT Yes/No residence checks
  if (/\b(where|which city|what city|what is your)\b/i.test(q)) {
    return null;
  }

  // 2. Questions asking "residing in X or willing to relocate?" -> Candidate is willing to relocate -> Yes
  if (/(?:residing|living|staying|based|located).{1,40}(?:or\s+willing\s+to\s+relocate|or\s+ready\s+to\s+relocate|or\s+open\s+to\s+relocate)/i.test(q)) {
    return { isResidenceQuestion: true, answer: 'Yes', targetCity: '' };
  }

  // 3. Pure relocation / willingness questions are handled separately (normally 'Yes')
  if (/\b(?:willing\s+to|ready\s+to|open\s+to|comfortable\s+to|can\s+you)\s+relocate\b/i.test(q)) {
    return null;
  }

  // 4. City residence check patterns
  const patterns = [
    // "Are you residing curretly in Hydrabad ?" / "Do you stay in Pune?" / "Is your current location Hyderabad?"
    /(?:are\s+you|do\s+you|is\s+your)\s+(?:currently|curretly|presently|at\s+present)?\s*(?:residing|living|staying|based|located|stay|live|reside|current\s+location)\s*(?:in|at|from|is)?\s+([a-zA-Z\s/,-]+?)(?:\s*\?|\s*\(|\s*$)/i,
    // "Currently residing in Hyderabad?" / "Living in Chennai?" / "Residing in Pune?"
    /^(?:currently|curretly|presently|at\s+present)?\s*(?:residing|living|staying|based|located)\s+(?:in|at)\s+([a-zA-Z\s/,-]+?)(?:\s*\?|\s*\(|\s*$)/i,
    // "Are you currently in Hyderabad?"
    /(?:are\s+you)\s+(?:currently|curretly|presently|at\s+present)\s+(?:in|at)\s+([a-zA-Z\s/,-]+?)(?:\s*\?|\s*\(|\s*$)/i,
    // "Current location : Hyderabad?" / "Current location - Pune?"
    /^current\s+location\s*[-:]\s*([a-zA-Z\s/,-]+?)(?:\s*\?|\s*\(|\s*$)/i,
  ];

  let rawTargetCity: string | null = null;
  for (const pat of patterns) {
    const match = q.match(pat);
    if (match && match[1]) {
      rawTargetCity = match[1].trim();
      break;
    }
  }

  if (!rawTargetCity) return null;

  // Clean trailing filler words like "city", "right now", "currently"
  const cleanedTarget = rawTargetCity
    .replace(/\s+(?:city|area|location|right now|currently|curretly)$/i, '')
    .trim();

  if (!cleanedTarget) return null;

  // Extract candidate city. Empty/unknown location means we cannot verify a
  // residence claim — return null so the caller answers from the profile (or
  // leaves it manual) instead of guessing from a hardcoded hometown.
  const candLoc = (candidateLocation || '').trim();
  if (!candLoc) return null;
  const candCityRaw = candLoc.split(',')[0].trim();
  const candNormalized = normalizeCityName(candCityRaw);

  // Target may contain multiple cities: e.g. "Hyderabad / Bangalore" or "Hyderabad or Bangalore"
  const targetCities = cleanedTarget.split(/\s*(?:\/|\bor\b|,)\s*/i).map(normalizeCityName);

  const isMatch = targetCities.some((c) => c === candNormalized);

  return {
    isResidenceQuestion: true,
    answer: isMatch ? 'Yes' : 'No',
    targetCity: cleanedTarget,
  };
}

// --- Category classification (regex on normalized text) -------------------

const CATEGORY_PATTERNS: Array<{ category: QuestionCategory; pattern: RegExp }> = [
  // EEO first — these are highly templated and must be matched precisely
  { category: 'eeo_race', pattern: /\b(race|ethnic(?:ity)?|hispanic|latin[oax])\b/i },
  { category: 'eeo_gender', pattern: /\b(gender|sex|transgender|male\/female)\b/i },
  { category: 'eeo_veteran', pattern: /\b(veteran|military|armed forces|protected veteran)\b/i },
  { category: 'eeo_disability', pattern: /\b(disabilit(?:y|ies)|disabled|ADA|impairment)\b/i },
  // Work auth & sponsorship
  { category: 'sponsorship', pattern: /\b(visa.+sponsor|sponsor.+visa|require sponsorship|H-?1B sponsor|need sponsorship)\b/i },
  { category: 'work_auth', pattern: /\b(authorized|legally allowed|right to work|work permit|eligible to work)\b/i },
  // URLs & Identity
  { category: 'portfolio', pattern: /\b(portfolio|website|github|git\s*hub|personal\s*site|online\s*(?:portfolio|profile|url))\b/i },
  { category: 'dob', pattern: /\b(date\s*of\s*birth|birth\s*date|dob)\b/i },
  // Comp
  { category: 'current_salary', pattern: /\b(?:current|present)\b.*?\b(?:ctc|salary|compensation|remuneration|package|pay|earnings?)\b/i },
  { category: 'salary', pattern: /\b(?:expected|target|desired|expectation|minimum)\b.*?\b(?:ctc|salary|compensation|remuneration|package|pay)\b/i },
  // Address & Location
  { category: 'street', pattern: /(?:street|address\s*line\s*1|home\s*address|\bstreet\s*address\b)/i },
  { category: 'state', pattern: /\b(?:state|province|region|state\s*\/\s*province)\b/i },
  { category: 'country', pattern: /\b(?:country|nation|country\s*\/\s*region)\b/i },
  { category: 'zipcode', pattern: /\b(?:zip\s*code|postal\s*code|pin\s*code|pincode|postcode)\b/i },
  // Logistics
  { category: 'notice_period', pattern: /\b(notice period|notice to serve|earliest start|how soon|when can you start|how soon you can join|join us.*days|joining\s*(?:time|period|days))\b/i },
  { category: 'start_date', pattern: /\b(start date|available to start)\b/i },
  { category: 'months_experience', pattern: /\b(additional\s*months?|months?\s*of\s*(?:\w+\s+)?(?:experience|exp))\b/i },
  { category: 'years_experience', pattern: /\b(total\s*years?|years?\s*of\s*(?:\w+\s+)?(?:experience|exp)|(?:total|overall|relevant|work|professional|it)\s*(?:years?\s*of\s*)?experience|^experience\b)\b/i },
  // Subjective / open-ended
  { category: 'why_company', pattern: /\bwhy (?:are you )?(?:interested|do you want|would you like) (?:in|to)?.{0,40}(this|our|company|role|position|join)/i },
  { category: 'location', pattern: /\b(current location|where do you (?:live|reside)|where are you based|residing|living in|staying in|based in|located in)\b/i },
];

export function classifyQuestion(question: string): QuestionCategory {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(question)) return category;
  }
  return 'other';
}

// --- Defaults-based answer (no LLM cost) ---------------------------------

function answerFromDefaults(
  question: string,
  category: QuestionCategory,
  defaults: ApplyDefaults,
  ctx: QuestionContext,
  profile: Record<string, unknown>,
): string | null {
  switch (category) {
    case 'work_auth': {
      // Try to detect country in question, fall back to first defined
      const countryGuess = /\b(US|United States|USA|UK|United Kingdom|India|Canada|Germany|EU|European|Singapore|Australia)\b/i.exec(question);
      if (countryGuess && defaults.workAuth) {
        const key = countryGuess[1].toUpperCase().replace(/UNITED STATES|USA/, 'US').replace(/UNITED KINGDOM/, 'UK').replace(/EUROPEAN/, 'EU');
        const v = defaults.workAuth[key] || defaults.workAuth[key.slice(0, 2)];
        if (v) return v === 'yes' ? 'Yes' : 'No';
      }
      // If no country specified and the candidate is in India, assume question is about US (most common case)
      const loc = (profile.location as string) || '';
      if (/india/i.test(loc) && defaults.workAuth?.US) return defaults.workAuth.US === 'yes' ? 'Yes' : 'No';
      return null;
    }
    case 'sponsorship':
      if (defaults.needsSponsorship) return defaults.needsSponsorship === 'yes' ? 'Yes' : 'No';
      // Default for India-based candidate applying globally: yes
      return /india/i.test((profile.location as string) || '') ? 'Yes' : null;
    case 'notice_period': {
      const days = defaults.noticePeriodDays ?? (profile.noticePeriodDays as number) ?? 30;
      if (days === 0) return 'Immediate';
      if (/in days|\bdays\b/i.test(question)) return String(days);
      return `${days} days`;
    }
    case 'current_salary': {
      // Profile-only: never invent compensation for a user who hasn't provided it.
      // null falls through to the answer cache, then the LLM, then manual entry.
      const numericDefault =
        defaults.currentSalary != null && /^\d+$/.test(defaults.currentSalary.trim())
          ? Number(defaults.currentSalary.trim())
          : undefined;
      const ctc = (profile.currentCtcInr as number | undefined) ?? numericDefault;
      if (ctc == null) return defaults.currentSalary || null;
      if (/monthly|per\s*month/i.test(question)) return String(Math.round(ctc / 12));
      if (/lpa|lakh/i.test(question)) return String(Math.round(ctc / 100000));
      if (/inr|in inr|in ₹|rupees|ctc/i.test(question)) return String(ctc);
      return defaults.currentSalary || String(ctc);
    }
    case 'salary': {
      const targets = (profile.targets as Record<string, unknown>) || {};
      const ctc =
        (profile.expectedCtcInr as number | undefined) ??
        (targets.comp_min as number | undefined);
      if (ctc == null) return defaults.expectedSalary || null;
      if (/monthly|per\s*month/i.test(question)) return String(Math.round(ctc / 12));
      if (/lpa|lakh/i.test(question)) return String(Math.round(ctc / 100000));
      if (/inr|in inr|in ₹|rupees|ctc/i.test(question)) return String(ctc);
      if (defaults.expectedSalary) return defaults.expectedSalary;
      return String(ctc);
    }
    case 'street':
      return (profile.street as string) || (profile.address as string) || null;
    case 'state':
      return (profile.state as string) || (profile.province as string) || null;
    case 'country':
      return (profile.country as string) || null;
    case 'zipcode': {
      const zip = profile.zipCode ?? profile.pincode ?? profile.postalCode;
      return zip != null ? String(zip) : null;
    }
    case 'portfolio':
      return (profile.portfolioUrl as string) || defaults.portfolioUrl || null;
    case 'dob':
      return (profile.dateOfBirth as string) || defaults.dateOfBirth || null;
    case 'start_date':
      return defaults.startDate || (defaults.noticePeriodDays === 0 ? 'Immediately' : null);
    case 'location': {
      const candidateLocation = (profile.location as string) || '';
      const cityResidence = matchCityResidenceQuestion(question, candidateLocation);
      if (cityResidence) return cityResidence.answer;
      return (profile.location as string) || null;
    }
    case 'eeo_race':
      return defaults.eeoRace || 'Prefer not to say';
    case 'eeo_gender':
      return defaults.eeoGender || 'Prefer not to say';
    case 'eeo_veteran':
      return defaults.eeoVeteran === 'yes' ? 'I am a veteran'
        : defaults.eeoVeteran === 'no' ? 'I am not a veteran'
        : 'Prefer not to say';
    case 'eeo_disability':
      return defaults.eeoDisability === 'yes' ? 'Yes, I have a disability'
        : defaults.eeoDisability === 'no' ? 'No, I do not have a disability'
        : 'Prefer not to say';
    case 'months_experience':
      return String((profile.totalExperienceMonths as number) ?? 6);
    case 'years_experience': {
      const yoe = (profile.yearsOfExperience as number) ?? (profile.yearsExperience as number) ?? 3;
      return String(yoe);
    }
    case 'why_company':
      // Always LLM-generated per-job; no usable default
      return null;
    case 'other':
      return null;
  }
  return null;
}

// --- LLM fallback --------------------------------------------------------

const LLM_PROMPT_TEMPLATE = (
  question: string,
  options: string[] | null,
  category: QuestionCategory,
  profile: Record<string, unknown>,
  ctx: QuestionContext,
) => `You are filling out a job application screening question on behalf of the candidate. Answer truthfully from their profile — do NOT invent.

CANDIDATE PROFILE:
${JSON.stringify({
  name: profile.name,
  location: profile.location,
  yearsOfExperience: profile.yearsOfExperience,
  seniority: profile.seniority,
  skills: (profile.skills as string[] | undefined)?.slice(0, 30),
  experience: (profile.experience as string[] | undefined)?.slice(0, 5),
  targets: profile.targets,
}, null, 2)}

JOB CONTEXT: ${ctx.jobTitle} at ${ctx.company}${ctx.jobLocation ? ` (${ctx.jobLocation})` : ''}

QUESTION CATEGORY: ${category}

QUESTION: ${question}

${options ? `OPTIONS (pick exactly one verbatim):\n${options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}` : ''}

RULES:
- Be concise. 1 sentence for open-ended; single word/phrase for yes/no.
- If question is "Why ${ctx.company}?" type — write 2-3 sentences citing 1 specific reason grounded in profile + job.
- If you cannot answer truthfully from the profile, return exactly: UNKNOWN
- If options are given, return ONLY the option text (no number, no extra words).
- No placeholders like [Your Name] — use real profile data.

ANSWER:`;

// --- Public API -----------------------------------------------------------

export async function answerScreeningQuestion(
  question: string,
  options: string[] | null,
  profile: Record<string, unknown>,
  ctx: QuestionContext,
  defaults: ApplyDefaults = {},
): Promise<AnswerResult> {
  const ownerId = screeningOwnerId(profile);
  ensureScreeningOwner(ownerId);
  const hash = hashScreeningQuestion(question, ownerId);
  const category = classifyQuestion(question);

  // 1. Defaults-based (no LLM cost, always honors current profile/settings)
  let defaultAnswer = answerFromDefaults(question, category, defaults, ctx, profile);
  if (defaultAnswer !== null) {
    if (options && options.length > 0) {
      const lower = defaultAnswer.toLowerCase();
      const snap = options.find((o) => o.toLowerCase() === lower) || options.find((o) => lower.includes(o.toLowerCase()));
      if (snap) defaultAnswer = snap;
    }
    saveAnswer(hash, question, defaultAnswer, category);
    return { answer: defaultAnswer, category, source: 'defaults', questionHash: hash };
  }

  // 2. Exact-match cache (for custom/LLM-generated past answers)
  const cached = db
    .prepare('SELECT answer FROM screening_answers WHERE question_hash = ?')
    .get(hash) as { answer: string } | undefined;
  if (cached) {
    // Bump usage stats async-style (we don't await; this is fire-and-forget)
    db.prepare('UPDATE screening_answers SET used_count = used_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE question_hash = ?').run(hash);
    return { answer: cached.answer, category, source: 'cache', questionHash: hash };
  }

  // 3. LLM fallback
  let llmAnswer = await primaryGenerate(LLM_PROMPT_TEMPLATE(question, options, category, profile, ctx), 256, 'creative');
  llmAnswer = llmAnswer.trim();
  if (llmAnswer === 'UNKNOWN' || !llmAnswer) {
    // Don't cache UNKNOWN — let user fill it manually in the preview
    return { answer: '', category, source: 'llm', questionHash: hash };
  }
  // If options provided, snap LLM answer to nearest option (case-insensitive)
  if (options && options.length > 0) {
    const lower = llmAnswer.toLowerCase();
    const snap = options.find((o) => o.toLowerCase() === lower) || options.find((o) => lower.includes(o.toLowerCase()));
    if (snap) llmAnswer = snap;
  }
  saveAnswer(hash, question, llmAnswer, category);
  return { answer: llmAnswer, category, source: 'llm', questionHash: hash };
}

function saveAnswer(hash: string, question: string, answer: string, category: QuestionCategory): void {
  db.prepare(
    `INSERT INTO screening_answers (question_hash, question, answer, category)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(question_hash) DO UPDATE SET
       answer = excluded.answer,
       category = excluded.category,
       used_count = used_count + 1,
       last_used_at = CURRENT_TIMESTAMP`,
  ).run(hash, question, answer, category);
}

// --- Settings I/O ---------------------------------------------------------

export function getApplyDefaults(): ApplyDefaults {
  try {
    const row = db.prepare('SELECT config_json FROM apply_settings WHERE id = 1').get() as { config_json: string } | undefined;
    if (!row) return {};
    const cfg = JSON.parse(row.config_json) as { defaults?: ApplyDefaults };
    return cfg.defaults || {};
  } catch {
    return {};
  }
}

export interface ApplyConfig {
  defaults: ApplyDefaults;
  // Only portals we can actually act on. `lever` and `linkedin` used to be listed here with
  // toggles the user could switch on, which promised submitters that were never written.
  portals: {
    greenhouse: boolean;
    ashby: boolean;
    linkedin: boolean;
    naukri: boolean;
    browser: boolean;
  };
  rateLimit: {
    perDay: number;       // total submissions per 24h
    perHour: number;      // total per hour
  };
  dryRun: boolean;
  resumeSource: 'original' | 'tailored'; // which resume to attach by default
  updateNaukriProfileResume?: boolean;   // upload tailored resume to Naukri profile before 1-click apply
}

const DEFAULT_CONFIG: ApplyConfig = {
  defaults: {
    eeoVeteran: 'prefer_not_to_say',
    eeoDisability: 'prefer_not_to_say',
  },
  portals: {
    greenhouse: true,
    ashby: true,
    linkedin: true,
    naukri: true,
    browser: true,
  },
  rateLimit: {
    perDay: 20,
    perHour: 5,
  },
  dryRun: false,
  resumeSource: 'tailored', // default to JD-tailored resume for every application
  updateNaukriProfileResume: true,
};

export function getApplyConfig(): ApplyConfig {
  try {
    const row = db.prepare('SELECT config_json FROM apply_settings WHERE id = 1').get() as { config_json: string } | undefined;
    if (!row) return DEFAULT_CONFIG;
    const cfg = JSON.parse(row.config_json) as Partial<ApplyConfig>;
    return {
      defaults: { ...DEFAULT_CONFIG.defaults, ...(cfg.defaults || {}) },
      portals: { ...DEFAULT_CONFIG.portals, ...(cfg.portals || {}) },
      rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...(cfg.rateLimit || {}) },
      dryRun: cfg.dryRun ?? DEFAULT_CONFIG.dryRun,
      resumeSource: cfg.resumeSource ?? DEFAULT_CONFIG.resumeSource,
      updateNaukriProfileResume: cfg.updateNaukriProfileResume ?? DEFAULT_CONFIG.updateNaukriProfileResume,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveApplyConfig(cfg: ApplyConfig): void {
  db.prepare(
    `INSERT INTO apply_settings (id, config_json, updated_at)
     VALUES (1, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = CURRENT_TIMESTAMP`,
  ).run(JSON.stringify(cfg));
}
