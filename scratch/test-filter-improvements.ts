import db from '../src/lib/db';
import { extractPostingFacts } from '../src/lib/posting-facts';
import { getCandidatePreferences } from '../src/lib/matches-page';
import { getRankedMatches } from '../src/lib/matches';

// Let's test the new extractExperience logic
function testExtractExperience(rawText: string, url = ''): { min: number | null; max: number | null; text: string } | null {
  if (url) {
    const urlRange = url.match(/[-_](\d{1,2})-to-(\d{1,2})-years?/i);
    if (urlRange) {
      const min = parseInt(urlRange[1], 10);
      const max = parseInt(urlRange[2], 10);
      if (min >= 0 && min <= 30 && max >= min && max <= 40) {
        return { min, max, text: `${min}-${max} yrs` };
      }
    }
    const urlPlus = url.match(/[-_](\d{1,2})-(?:plus-)?years?/i);
    if (urlPlus) {
      const min = parseInt(urlPlus[1], 10);
      if (min >= 0 && min <= 30) {
        return { min, max: null, text: `${min}+ yrs` };
      }
    }
  }

  // Comprehensive normalization:
  // 1. Replace non-breaking spaces, underscores, pipes, slashes with regular spaces so word boundaries work
  // 2. Separate attached letters and numbers (e.g. "Skills6+ years" -> "Skills 6+ years", "Qualifications5–8" -> "Qualifications 5–8")
  // 3. Normalize en-dash and em-dash to regular hyphen
  const normalized = (rawText || '')
    .replace(/[\u00A0\t\r\n_|\/\\]/g, ' ')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[\u2013\u2014]/g, '-');

  const EXP_RANGE_RE = /\b(\d{1,2})\s*(?:[-–—to]+|\bto\b)\s*(\d{1,2})\s*(?:\+)?\s*(?:years?|yrs?|yoe)?\b(?!\s*old)/i;
  const EXP_PREFIX_RANGE_RE = /\b(?:experience|exp)[:\s]+(\d{1,2})\s*(?:[-–—to]+|\bto\b)\s*(\d{1,2})\s*(?:years?|yrs?|yoe)?\b(?!\s*old)/i;
  const EXP_PLUS_RE = /\b(\d{1,2})\s*\+\s*(?:years?|yrs?|yoe)\b(?!\s*old)/i;
  const EXP_YOE_RE = /\b(\d{1,2})\s*(?:\+)?\s*(?:yoe|years?\s*(?:of\s*)?exp(?:erience)?)\b(?!\s*old)/i;
  const EXP_MIN_RE = /\b(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2})\s*(?:years?|yrs?|yoe)\b/i;
  const EXP_WORD_RE = /\b(\d{1,2})\s*(?:\+)?\s*(?:years?|yrs?|yoe)\s+(?:of\s+)?(?:hands-on\s+)?(?:relevant\s+)?experience\b/i;

  const range = EXP_RANGE_RE.exec(normalized) || EXP_PREFIX_RANGE_RE.exec(normalized);
  if (range) {
    const min = parseInt(range[1], 10);
    const max = parseInt(range[2], 10);
    if (min >= 0 && min <= 30 && max >= min && max <= 40) {
      return { min, max, text: `${min}-${max} yrs` };
    }
  }

  const plus = EXP_PLUS_RE.exec(normalized);
  if (plus) {
    const min = parseInt(plus[1], 10);
    if (min >= 0 && min <= 30) {
      return { min, max: null, text: `${min}+ yrs` };
    }
  }

  const yoe = EXP_YOE_RE.exec(normalized);
  if (yoe) {
    const min = parseInt(yoe[1], 10);
    if (min >= 0 && min <= 30) {
      return { min, max: null, text: `${min}+ yrs` };
    }
  }

  const minOnly = EXP_MIN_RE.exec(normalized);
  if (minOnly) {
    const min = parseInt(minOnly[1], 10);
    if (min >= 0 && min <= 30) {
      return { min, max: null, text: `${min}+ yrs` };
    }
  }

  const wordExp = EXP_WORD_RE.exec(normalized);
  if (wordExp) {
    const min = parseInt(wordExp[1], 10);
    if (min >= 0 && min <= 30) {
      return { min, max: null, text: `${min}+ yrs` };
    }
  }

  return null;
}

const prefs = getCandidatePreferences();
console.log('Candidate prefs:', prefs);

// Let's test on all job postings in DB
const jobs = db.prepare('SELECT id, title, company, description, url FROM job_postings LIMIT 60').all();

let excludedCount = 0;
let keptCount = 0;

console.log('\n--- EVALUATING JOBS FOR CANDIDATE (3 YOE) ---');
for (const j of jobs) {
  const text = `${j.title}\n${j.url}\n${j.description || ''}`;
  const exp = testExtractExperience(text, j.url || '');
  
  // Check experience compatibility
  let compatible = true;
  let reason = '';

  if (exp) {
    if (exp.min != null && exp.min > prefs.yearsOfExperience) {
      compatible = false;
      reason = `Required exp ${exp.text} exceeds candidate (${prefs.yearsOfExperience} yrs)`;
    } else if (exp.max != null && exp.max < 2) {
      compatible = false;
      reason = `Required exp ${exp.text} too junior for candidate (${prefs.yearsOfExperience} yrs)`;
    }
  }

  // Seniority check on title for candidate <= 4 YOE
  const isLeadOrAbove = /\b(lead|principal|staff|architect|director|head\s+of|manager|vp)\b/i.test(j.title);
  if (isLeadOrAbove && !prefs.targetRoles.some(r => /\b(lead|principal|staff|architect|director)\b/i.test(r))) {
    compatible = false;
    reason = `Title "${j.title}" is Lead/Principal/Architect role (candidate is 3 YOE)`;
  }

  if (!compatible) {
    excludedCount++;
    console.log(`[EXCLUDED] Job ${j.id}: "${j.title}" (${j.company}) -> Reason: ${reason}`);
  } else {
    keptCount++;
    console.log(`[KEPT]     Job ${j.id}: "${j.title}" (${j.company}) | Exp: ${exp ? exp.text : 'unspecified'}`);
  }
}

console.log(`\nTotal Kept: ${keptCount}, Total Excluded: ${excludedCount}`);
