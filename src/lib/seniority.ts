// Seniority / relevance gate for broad job sources.
//
// The user is a 15-year architect who wants ALL genuinely-matching senior tech roles across
// industries (healthcare-first, but not healthcare-only). Broad boards (Himalayas, WWR,
// 4dayweek, career-page discovery) return everything, so we keep senior technical/architect
// roles and drop clearly-junior or clearly-irrelevant functions before they ever hit the DB.
//
// Pure function, no side effects — safe to import from both Next code and ts-node scripts.
// domain_priority (healthcare) is applied as an OR by callers, so on-domain jobs are never
// dropped by this gate even if their title is unusual.

const TECH_TITLE_RE =
  /\b(architect|principal|staff|lead|senior|sr\.?|head of|director|vp|engineer|engineering|developer|programmer|swe|sde|devops|sre|site reliability|platform|infrastructure|data|cloud|integration|solutions?|technical|cto|software|full[- ]?stack|back[- ]?end|front[- ]?end)\b/i;

const JUNIOR_RE =
  /\b(intern|internship|junior|jr\.?|graduate|trainee|entry[- ]?level|apprentice|working student|fresher|co[- ]?op)\b/i;

const IRRELEVANT_RE =
  /\b(sales|account executive|business development|recruit|talent acquisition|marketing|seo|content writer|copywriter|billing|accounts? payable|accountant|bookkeep|customer support|customer success|technical support|help ?desk|nurse|nursing|clinical|physician|therapist|medical coder|social media|community manager|human resources|receptionist|administrative assistant|office manager|paralegal|legal counsel|teacher|tutor)\b/i;

/**
 * True when a title looks like a technical role worth surfacing. Always excludes
 * non-engineering functions (sales, recruiting, clinical, etc.) and requires a tech
 * signal. Callers typically use:
 *   isDomainPriority(text) || isSeniorRelevant(title, { allowJunior })
 * so on-domain jobs pass regardless of title shape.
 *
 * `allowJunior` makes the gate experience-aware: by default junior/entry/intern titles
 * are dropped (the senior-user default), but when the candidate is early-career the
 * caller passes `allowJunior: true` so those roles are KEPT. Resolve it once per run
 * from the profile — see resolveAllowJunior in scripts/shared/profile-level.ts.
 */
export function isSeniorRelevant(title: string, opts?: { allowJunior?: boolean }): boolean {
  const t = title || '';
  if (IRRELEVANT_RE.test(t)) return false;
  if (!opts?.allowJunior && JUNIOR_RE.test(t)) return false;
  return TECH_TITLE_RE.test(t);
}
