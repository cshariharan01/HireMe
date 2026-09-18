// Pull at-a-glance facts out of a job description — Naukri-style "quick view"
// info for the dashboard card + a prominent strip on the job detail page.
//
// Pure regex extraction. No LLM cost. Returns null fields when not findable
// instead of guessing — the UI hides chips for missing fields.

export type WorkMode = 'remote' | 'hybrid' | 'onsite' | null;
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary' | null;

export interface PostingFacts {
  salaryText: string | null;   // formatted display string, e.g. "₹15-25L" or "$120-180K"
  salaryMin: number | null;    // numeric value in source currency
  salaryMax: number | null;
  salaryCurrency: 'INR' | 'USD' | 'GBP' | 'EUR' | null;
  experienceText: string | null; // e.g. "5-10 yrs" or "8+ yrs"
  experienceMin: number | null;
  experienceMax: number | null;
  workMode: WorkMode;
  employmentType: EmploymentType;
}

// ---------- Salary ----------
// We support common formats:
//   ₹15-25 LPA / ₹15-25 L / 15-25 LPA
//   INR 15,00,000 - 25,00,000 / Rs 1,500,000 - 2,500,000
//   $120,000 - $180,000 / $120K - $180K / 120k-180k USD
//   £80,000 - £120,000 / €80K - €120K
// We also tolerate "10 to 15 lakhs" style.

interface SalaryHit {
  min: number;
  max: number;
  currency: 'INR' | 'USD' | 'GBP' | 'EUR';
  text: string;
}

const INR_LAKHS_RE = /(?:₹|inr\s*|rs\.?\s*)?\s*(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*(?:l(?:akhs?)?(?:\s*pa|\s*per\s*annum)?|lpa|lakhs?)\b/gi;
const INR_FULL_RE = /(?:₹|inr|rs\.?)\s*([\d,]+)\s*[-–to]+\s*([\d,]+)/gi;
const USD_RE = /\$\s*(\d+(?:\.\d+)?)\s*[kK]?\s*[-–to]+\s*\$?\s*(\d+(?:\.\d+)?)\s*[kK](?:\s*\/?\s*(?:yr|year|annum))?/g;
const USD_FULL_RE = /\$\s*([\d,]+)\s*[-–to]+\s*\$?\s*([\d,]+)/g;
const GBP_RE = /£\s*(\d+(?:\.\d+)?)\s*[kK]?\s*[-–to]+\s*£?\s*(\d+(?:\.\d+)?)\s*[kK]/g;
const EUR_RE = /€\s*(\d+(?:\.\d+)?)\s*[kK]?\s*[-–to]+\s*€?\s*(\d+(?:\.\d+)?)\s*[kK]/g;

function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}K`;
}

function extractSalary(text: string): SalaryHit | null {
  // Try lakhs first — Indian postings most common
  INR_LAKHS_RE.lastIndex = 0;
  const lakhs = INR_LAKHS_RE.exec(text);
  if (lakhs) {
    const min = parseNum(lakhs[1]);
    const max = parseNum(lakhs[2]);
    return { min, max, currency: 'INR', text: `₹${min}-${max}L` };
  }
  // Full INR amounts (e.g. ₹15,00,000 - 25,00,000)
  INR_FULL_RE.lastIndex = 0;
  const inrFull = INR_FULL_RE.exec(text);
  if (inrFull) {
    const min = parseNum(inrFull[1]);
    const max = parseNum(inrFull[2]);
    if (min >= 100000 && max >= min) {
      const minL = min / 100000;
      const maxL = max / 100000;
      return { min: minL, max: maxL, currency: 'INR', text: `₹${minL.toFixed(0)}-${maxL.toFixed(0)}L` };
    }
  }
  // USD with K suffix
  USD_RE.lastIndex = 0;
  const usdK = USD_RE.exec(text);
  if (usdK) {
    const min = parseNum(usdK[1]);
    const max = parseNum(usdK[2]);
    // Only accept if values look like K-suffix salaries (10-500)
    if (min >= 10 && min <= 500 && max >= min && max <= 1000) {
      return { min: min * 1000, max: max * 1000, currency: 'USD', text: `${fmtUsd(min * 1000)}-${fmtUsd(max * 1000)}` };
    }
  }
  // Full USD amounts (e.g. $120,000 - $180,000)
  USD_FULL_RE.lastIndex = 0;
  const usdFull = USD_FULL_RE.exec(text);
  if (usdFull) {
    const min = parseNum(usdFull[1]);
    const max = parseNum(usdFull[2]);
    if (min >= 10_000 && max >= min && max <= 2_000_000) {
      return { min, max, currency: 'USD', text: `${fmtUsd(min)}-${fmtUsd(max)}` };
    }
  }
  // GBP / EUR
  GBP_RE.lastIndex = 0;
  const gbp = GBP_RE.exec(text);
  if (gbp) {
    const min = parseNum(gbp[1]);
    const max = parseNum(gbp[2]);
    if (min >= 10 && min <= 500) {
      return { min: min * 1000, max: max * 1000, currency: 'GBP', text: `£${Math.round(min)}K-£${Math.round(max)}K` };
    }
  }
  EUR_RE.lastIndex = 0;
  const eur = EUR_RE.exec(text);
  if (eur) {
    const min = parseNum(eur[1]);
    const max = parseNum(eur[2]);
    if (min >= 10 && min <= 500) {
      return { min: min * 1000, max: max * 1000, currency: 'EUR', text: `€${Math.round(min)}K-€${Math.round(max)}K` };
    }
  }
  return null;
}

// ---------- Experience ----------
const EXP_PREFIX_RANGE_RE =
  /\b(?:overall\s+)?(?:experience|exp|total\s+exp(?:erience)?)\s*[:\s-]+\s*(\d{1,2})\s*(?:[-–—to]+|\bto\b)\s*(\d{1,2})\s*(?:years?|yeas?|yrs?|yoe)?\b(?!\s*old)/i;
const EXP_PREFIX_PLUS_RE =
  /\b(?:overall\s+)?(?:experience|exp|total\s+exp(?:erience)?)\s*[:\s-]+\s*(\d{1,2})\s*\+(?:\s*(?:years?|yeas?|yrs?|yoe))?/i;
const EXP_PREFIX_SINGLE_RE =
  /\b(?:overall\s+)?(?:experience|exp|total\s+exp(?:erience)?)\s*[:\s-]+\s*(\d{1,2})\s*(?:years?|yeas?|yrs?|yoe)\b(?!\s*old)/i;
const EXP_MIN_RE =
  /\b(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2})\s*(?:\+)?\s*(?:years?|yeas?|yrs?|yoe)\b/i;
const EXP_RANGE_RE =
  /\b(\d{1,2})\s*(?:[-–—to]+|\bto\b)\s*(\d{1,2})\s*(?:\+)?\s*(?:years?|yeas?|yrs?|yoe)\b(?!\s*(?:old|mins?|minutes?|hours?|hrs?|days?|weeks?|months?|am|pm|%))/i;
const EXP_PLUS_RE =
  /\b(\d{1,2})\s*\+\s*(?:years?|yeas?|yrs?|yoe)\b(?!\s*(?:old|mins?|minutes?|hours?|hrs?|days?|weeks?|months?|am|pm|%))/i;
const EXP_YOE_RE =
  /\b(\d{1,2})\s*(?:\+)?\s*(?:yoe|yo\s*e|years?\s*(?:of\s*)?(?:hands-on\s+)?(?:relevant\s+)?exp(?:erience)?)\b(?!\s*old)/i;
const EXP_WORD_RE =
  /\b(\d{1,2})\s*(?:\+)?\s*(?:years?|yeas?|yrs?|yoe)\s+(?:of\s+)?(?:hands-on\s+)?(?:relevant\s+)?experience\b/i;

export function extractExperience(text: string, url = ''): { min: number | null; max: number | null; text: string } | null {
  // Normalize camelCase / missing spaces from concatenated HTML elements, non-breaking spaces, underscores, pipes
  const normalized = (text || '')
    .replace(/[\u00A0\t\r_|\/\\]/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/(\+)([a-zA-Z])/g, '$1 $2')
    .replace(/\b(exp|experience)\s*-\s*(\d)/gi, '$1: $2');

  let textExp: { min: number | null; max: number | null; text: string } | null = null;

  const prefRange = EXP_PREFIX_RANGE_RE.exec(normalized);
  if (prefRange) {
    const min = parseInt(prefRange[1], 10);
    const max = parseInt(prefRange[2], 10);
    if (min >= 0 && min <= 30 && max >= min && max <= 40) {
      textExp = { min, max, text: `${min}-${max} yrs` };
    }
  }

  if (!textExp) {
    const prefPlus = EXP_PREFIX_PLUS_RE.exec(normalized);
    if (prefPlus) {
      const min = parseInt(prefPlus[1], 10);
      if (min >= 0 && min <= 30) {
        textExp = { min, max: null, text: `${min}+ yrs` };
      }
    }
  }

  if (!textExp) {
    const prefSingle = EXP_PREFIX_SINGLE_RE.exec(normalized);
    if (prefSingle) {
      const min = parseInt(prefSingle[1], 10);
      if (min >= 0 && min <= 30) {
        textExp = { min, max: null, text: `${min}+ yrs` };
      }
    }
  }

  if (!textExp) {
    const minOnly = EXP_MIN_RE.exec(normalized);
    if (minOnly) {
      const min = parseInt(minOnly[1], 10);
      if (min >= 0 && min <= 30) {
        textExp = { min, max: null, text: `${min}+ yrs` };
      }
    }
  }

  if (!textExp) {
    const range = EXP_RANGE_RE.exec(normalized);
    if (range) {
      const min = parseInt(range[1], 10);
      const max = parseInt(range[2], 10);
      if (min >= 0 && min <= 30 && max >= min && max <= 40) {
        textExp = { min, max, text: `${min}-${max} yrs` };
      }
    }
  }

  if (!textExp) {
    const plus = EXP_PLUS_RE.exec(normalized);
    if (plus) {
      const min = parseInt(plus[1], 10);
      if (min >= 0 && min <= 30) {
        textExp = { min, max: null, text: `${min}+ yrs` };
      }
    }
  }

  if (!textExp) {
    const yoe = EXP_YOE_RE.exec(normalized);
    if (yoe) {
      const min = parseInt(yoe[1], 10);
      if (min >= 0 && min <= 30) {
        textExp = { min, max: null, text: `${min}+ yrs` };
      }
    }
  }

  if (!textExp) {
    const wordExp = EXP_WORD_RE.exec(normalized);
    if (wordExp) {
      const min = parseInt(wordExp[1], 10);
      if (min >= 0 && min <= 30) {
        textExp = { min, max: null, text: `${min}+ yrs` };
      }
    }
  }

  let urlExp: { min: number | null; max: number | null; text: string } | null = null;
  if (url) {
    const urlRange = url.match(/[-_](\d{1,2})-to-(\d{1,2})-years?/i);
    if (urlRange) {
      const min = parseInt(urlRange[1], 10);
      const max = parseInt(urlRange[2], 10);
      if (min >= 0 && min <= 30 && max >= min && max <= 40) {
        urlExp = { min, max, text: `${min}-${max} yrs` };
      }
    }
    if (!urlExp) {
      const urlPlus = url.match(/[-_](\d{1,2})-(?:plus-)?years?/i);
      if (urlPlus) {
        const min = parseInt(urlPlus[1], 10);
        if (min >= 0 && min <= 30) {
          urlExp = { min, max: null, text: `${min}+ yrs` };
        }
      }
    }
  }

  // When text explicitly mentions experience, use it.
  // It avoids recruiter portal category mismatches (e.g. 1-3 yrs in URL, but 4+ yrs in JD text).
  if (textExp) {
    return textExp;
  }
  return urlExp;
}

// ---------- Work mode ----------
function extractWorkMode(text: string, location: string): WorkMode {
  const t = (text + ' ' + location).toLowerCase();
  // Hybrid wins if both keywords appear
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\b(fully\s+remote|remote(\s+(role|position|job|work))?|work\s+from\s+(home|anywhere))\b/.test(t)) return 'remote';
  if (/\b(on[-\s]?site|in[-\s]?office|in[-\s]?person)\b/.test(t)) return 'onsite';
  if (/\bremote\b/.test(t)) return 'remote';
  return null;
}

// ---------- Employment type ----------
function extractEmploymentType(text: string): EmploymentType {
  const t = text.toLowerCase();
  if (/\b(intern(?:ship)?)\b/.test(t) && !/\bnot\s+an?\s+internship\b/.test(t)) return 'internship';
  if (/\b(contract|contractor|c2c|c2h|contract[- ]to[- ]hire|freelance)\b/.test(t)) return 'contract';
  if (/\b(part[- ]?time)\b/.test(t)) return 'part-time';
  if (/\b(temporary|temp\s+role|short[- ]?term)\b/.test(t)) return 'temporary';
  if (/\b(full[- ]?time|permanent|fte\b)\b/.test(t)) return 'full-time';
  return null;
}

export function extractPostingFacts(description: string, location = '', title = '', url = ''): PostingFacts {
  const text = `${title}\n${url}\n${description || ''}`;
  const sal = extractSalary(text);
  const exp = extractExperience(text, url);

  return {
    salaryText: sal?.text || null,
    salaryMin: sal?.min ?? null,
    salaryMax: sal?.max ?? null,
    salaryCurrency: sal?.currency || null,
    experienceText: exp?.text || null,
    experienceMin: exp?.min ?? null,
    experienceMax: exp?.max ?? null,
    workMode: extractWorkMode(description || '', location),
    employmentType: extractEmploymentType(description || ''),
  };
}
