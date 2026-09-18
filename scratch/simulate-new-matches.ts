import db from '../src/lib/db';
import { getRankedMatches } from '../src/lib/matches';
import { getCandidatePreferences } from '../src/lib/matches-page';
import { isSeniorityCompatible } from '../src/lib/target-job-filter';

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
const res = getRankedMatches({ refresh: true });
if (!res) {
  console.log('No matches');
  process.exit(0);
}

console.log('Total ranked matches in pool:', res.ranked.length);

const approved = res.ranked.filter((m) => {
  // Title seniority check
  if (prefs.yearsOfExperience <= 4.5) {
    if (/\b(lead|principal|staff|architect|director|head\s+of|manager|vp)\b/i.test(m.title)) {
      return false;
    }
  }
  if (prefs.yearsOfExperience >= 1.5) {
    if (/\b(intern|internship|fresher|trainee|apprentice|entry[- ]?level)\b/i.test(m.title)) {
      return false;
    }
  }

  // Check experience
  const rawText = `${m.title} ${m.url} ${m.facts?.experienceText || ''}`;
  const exp = testExtractExperience(rawText, m.url);
  const min = m.facts?.experienceMin ?? exp?.min;
  const max = m.facts?.experienceMax ?? exp?.max;

  if (min != null && min > prefs.yearsOfExperience) {
    return false;
  }
  if (max != null && max < 2 && prefs.yearsOfExperience >= 3) {
    return false;
  }

  return true;
});

console.log('Filtered matches count:', approved.length);
console.log('First 20 approved jobs:');
approved.slice(0, 20).forEach((m, idx) => {
  console.log(`[#${idx + 1}] ID=${m.id} | "${m.title}" | Company: "${m.company}" | ExpMin: ${m.facts?.experienceMin} | ExpText: "${m.facts?.experienceText}"`);
});
