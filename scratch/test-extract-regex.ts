import db from '../src/lib/db';

const jobs = db.prepare('SELECT id, title, location, description, url FROM job_postings WHERE id IN (18053, 18066, 18082, 17917, 17668, 18090, 18054, 18060)').all();

for (const j of jobs) {
  const rawText = `${j.title}\n${j.url}\n${j.description || ''}`;
  
  // Test normalization
  const normalized = rawText
    .replace(/[\u00A0\t\r_|\/\\]/g, ' ')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2');

  const EXP_RANGE_RE = /\b(\d{1,2})\s*(?:[-–—to]+|\bto\b)\s*(\d{1,2})\s*(?:\+)?\s*(?:years?|yrs?|yoe)?\b(?!\s*old)/i;
  const EXP_PLUS_RE = /\b(\d{1,2})\s*\+\s*(?:years?|yrs?|yoe)\b(?!\s*old)/i;
  const EXP_YOE_RE = /\b(\d{1,2})\s*(?:\+)?\s*(?:yoe|years?\s*(?:of\s*)?exp(?:erience)?)\b(?!\s*old)/i;
  const EXP_MIN_RE = /\b(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2})\s*(?:years?|yrs?|yoe)\b/i;
  const EXP_WORD_RE = /\b(\d{1,2})\s*(?:\+)?\s*(?:years?|yrs?|yoe)\s+(?:of\s+)?(?:hands-on\s+)?(?:relevant\s+)?experience\b/i;

  const range = EXP_RANGE_RE.exec(normalized);
  const plus = EXP_PLUS_RE.exec(normalized);
  const yoe = EXP_YOE_RE.exec(normalized);
  const minOnly = EXP_MIN_RE.exec(normalized);
  const wordExp = EXP_WORD_RE.exec(normalized);

  console.log(`\nJob ${j.id}: "${j.title}"`);
  console.log('  range match:', range ? `${range[1]}-${range[2]} (${range[0]})` : null);
  console.log('  plus match:', plus ? `${plus[1]}+ (${plus[0]})` : null);
  console.log('  yoe match:', yoe ? `${yoe[1]} (${yoe[0]})` : null);
  console.log('  min match:', minOnly ? `${minOnly[1]} (${minOnly[0]})` : null);
  console.log('  wordExp match:', wordExp ? `${wordExp[1]} (${wordExp[0]})` : null);
}
