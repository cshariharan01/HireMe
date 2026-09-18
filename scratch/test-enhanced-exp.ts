import db from '../src/lib/db';

const testIds = [18000, 18121, 17940, 17946, 17974, 18053, 17668, 18090, 18066, 17917, 18082];
const jobs = db.prepare(`SELECT id, title, company, description, url FROM job_postings WHERE id IN (${testIds.join(',')})`).all();

function parseExp(text: string): any {
  // Normalize:
  // 1. Whitespace and structural characters
  // 2. Separate letter-number and symbol-letter boundaries like 5+Location, 5+years, Exp-5
  let norm = (text || '')
    .replace(/[\u00A0\t\r_|\/\\]/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/(\+)([a-zA-Z])/g, '$1 $2')
    .replace(/\b(exp|experience)\s*-\s*(\d)/gi, '$1: $2');

  // Regexes
  // 1. Prefix with plus: "Exp: 5+", "Overall Exp-5+", "Experience: 5+ years", "Total Exp: 5+"
  const EXP_PREFIX_PLUS = /\b(?:overall\s+)?(?:experience|exp|total\s+exp(?:erience)?)\s*[:\s-]+\s*(\d{1,2})\s*\+/i;
  
  // 2. Prefix range: "Exp: 6-10 yrs", "Experience: 5 to 8 years", "Exp: 6 to 10"
  const EXP_PREFIX_RANGE = /\b(?:overall\s+)?(?:experience|exp|total\s+exp(?:erience)?)\s*[:\s-]+\s*(\d{1,2})\s*(?:[-–—to]+|\bto\b)\s*(\d{1,2})/i;
  
  // 3. Prefix single value: "Exp: 5 years", "Experience: 5 yrs"
  const EXP_PREFIX_SINGLE = /\b(?:overall\s+)?(?:experience|exp|total\s+exp(?:erience)?)\s*[:\s-]+\s*(\d{1,2})\s*(?:years?|yeas?|yrs?|yoe)\b/i;

  // 4. Standard range: "6-8 years", "6 to 10 yrs"
  const EXP_RANGE = /\b(\d{1,2})\s*(?:[-–—to]+|\bto\b)\s*(\d{1,2})\s*(?:\+)?\s*(?:years?|yeas?|yrs?|yoe)?\b(?!\s*old)/i;

  // 5. Standard plus: "5+ years", "5+ yrs", "5+ yoe"
  const EXP_PLUS = /\b(\d{1,2})\s*\+\s*(?:years?|yeas?|yrs?|yoe)\b(?!\s*old)/i;

  // 6. "X YoE" / "X years experience"
  const EXP_YOE = /\b(\d{1,2})\s*(?:\+)?\s*(?:yoe|yo\s*e|years?\s*(?:of\s*)?(?:hands-on\s+)?(?:relevant\s+)?exp(?:erience)?)\b(?!\s*old)/i;

  // 7. Minimum / At least X years
  const EXP_MIN = /\b(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2})\s*(?:\+)?\s*(?:years?|yeas?|yrs?|yoe)\b/i;

  // Check in order of specificity
  let m = EXP_PREFIX_RANGE.exec(norm);
  if (m) return { min: Number(m[1]), max: Number(m[2]), text: `${m[1]}-${m[2]} yrs`, source: 'prefix_range' };

  m = EXP_PREFIX_PLUS.exec(norm);
  if (m) return { min: Number(m[1]), max: null, text: `${m[1]}+ yrs`, source: 'prefix_plus' };

  m = EXP_PREFIX_SINGLE.exec(norm);
  if (m) return { min: Number(m[1]), max: null, text: `${m[1]}+ yrs`, source: 'prefix_single' };

  m = EXP_RANGE.exec(norm);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (min >= 0 && min <= 30 && max >= min && max <= 40) {
      return { min, max, text: `${min}-${max} yrs`, source: 'range' };
    }
  }

  m = EXP_PLUS.exec(norm);
  if (m) return { min: Number(m[1]), max: null, text: `${m[1]}+ yrs`, source: 'plus' };

  m = EXP_MIN.exec(norm);
  if (m) return { min: Number(m[1]), max: null, text: `${m[1]}+ yrs`, source: 'min' };

  m = EXP_YOE.exec(norm);
  if (m) return { min: Number(m[1]), max: null, text: `${m[1]}+ yrs`, source: 'yoe' };

  return null;
}

for (const j of jobs as any[]) {
  const fullText = `${j.title}\n${j.url}\n${j.description || ''}`;
  const res = parseExp(fullText);
  console.log(`Job ${j.id}: "${j.title}" (${j.company})`);
  console.log('  Result:', res);
}
