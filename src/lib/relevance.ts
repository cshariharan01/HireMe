// relevance.ts — how well does a posting actually fit this candidate, and why.
//
// Replaces the old `finalScore = cosine + stacked boosts` sum, which was printed as a percentage.
// That was wrong in three ways, all measured on the live DB before this file existed:
//   1. `nomic-embed-text` cosine only spans ~0.29-0.83 over the corpus, so every plausible job
//      read as 70-99% and half the pool sat above 69%.
//   2. The boosts pushed the sum PAST 1.0 and it was clamped to 100 — seven different jobs all
//      displayed exactly "100%", destroying the ordering between them.
//   3. Nothing compared the candidate's skills to the JD's requirements, so
//      `Java Solution Architect - Spring Boot` scored 98% for a candidate with no Java at all.
//
// The model here is a bounded weighted composite of four independent 0..1 signals, so 100 means
// "strong on every axis" rather than "cosine was high and the boosts stacked". Every component is
// returned alongside the score so the UI can show WHY, and so a wrong score is debuggable.

import { canonicalizeSkill, findSkills, hasSkill, skillGroup } from './skills-vocab';

/**
 * Canonical, lowercase set of everything the candidate demonstrably has: their listed skills
 * canonicalised onto the vocabulary, PLUS every vocabulary skill detectable in the joined skill
 * text (so "Azure Kubernetes Service" on the résumé also satisfies "Kubernetes"). Build once per
 * ranking run and hand it to `analyzeSkillFit`.
 */
export function buildProfileSkillSet(profileSkills: string[]): Set<string> {
  const canon = profileSkills.map(canonicalizeSkill);
  const set = new Set(canon.map((s) => s.trim().toLowerCase()));
  for (const found of findSkills(canon.join(' | '))) set.add(found.trim().toLowerCase());
  return set;
}

export interface SkillFit {
  /** Vocabulary skills the JD asks for. */
  required: string[];
  /** Required skills the candidate has. */
  matched: string[];
  /** Required skills the candidate lacks — the signal that was entirely missing before. */
  missing: string[];
  /** Missing skills named in the TITLE. A title skill you lack is close to disqualifying. */
  missingInTitle: string[];
  /** 0..1 coverage of the JD's requirements, title requirements weighted double. */
  score: number;
}

/**
 * Deduplicate skills where one skill's name is a constituent substring of another longer skill
 * in the same text and does not appear independently (e.g. "Azure" inside "Azure Data Factory").
 */
export function pruneSubsumedSkills(skills: string[], text: string): string[] {
  if (skills.length <= 1 || !text) return skills;
  const lowerText = text.toLowerCase();
  const sorted = [...skills].sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const s of sorted) {
    const sLower = s.toLowerCase();
    const subsumedBy = kept.find((longer) => {
      const longerLower = longer.toLowerCase();
      if (!longerLower.includes(sLower)) return false;
      const escape = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const countS = (lowerText.match(new RegExp(`\\b${escape(sLower)}\\b`, 'gi')) || []).length;
      const countLonger = (lowerText.match(new RegExp(`\\b${escape(longerLower)}\\b`, 'gi')) || []).length;
      return countS <= countLonger;
    });
    if (!subsumedBy) {
      kept.push(s);
    }
  }
  return kept;
}

/**
 * Compare a posting's required skills against the candidate's.
 *
 * Title terms count double: a JD body mentioning Kafka once is context, but "Java Developer" in
 * the title means the role IS Java. When a JD names no vocabulary skills at all (vague postings)
 * we return a neutral 0.5 rather than 0 — absence of evidence is not evidence of mismatch.
 */
export function analyzeSkillFit(args: {
  jobTitle: string;
  jobDescription: string;
  profileSkills: string[];
  /**
   * Pre-extracted skills for this posting (from the `job_skills` cache).
   *
   * Extraction scans the ~175-entry vocabulary over the description and costs ~6ms per job.
   * Across the ~1,600 candidates a recompute scores, that is ~10 SECONDS — and it was being redone
   * on every cache miss, which is what took the cold recompute from 1.2s to 21s. The extraction is
   * CONSTANT per job (a description never changes after ingest); only the comparison against the
   * résumé is per-profile. Pass these in and a recompute does set operations instead of regex
   * scans. Omit them and they are extracted inline (correct, just slow).
   */
  cached?: { titleSkills: string[]; bodySkills: string[] };
  /**
   * The candidate's skills as a lowercase canonical Set, from `buildProfileSkillSet`. Build it
   * ONCE per ranking run and pass it in — see the note on `has()` below.
   */
  profileSkillSet?: Set<string>;
}): SkillFit {
  const title = args.jobTitle || '';
  const body = args.jobDescription || '';
  const profile = args.profileSkills.map(canonicalizeSkill);
  const profileBlob = profile.join(' \n ');

  const rawTitleSkills = args.cached ? args.cached.titleSkills : findSkills(title);
  const requiredInTitle = pruneSubsumedSkills(rawTitleSkills, title);
  const rawBodySkills = args.cached ? args.cached.bodySkills : findSkills(body);
  const bodySkills = pruneSubsumedSkills(rawBodySkills, body);
  const required = Array.from(new Set([...requiredInTitle, ...bodySkills]));

  // With a prebuilt set this is a hash lookup. Without one it falls back to
  // `hasSkill(profileBlob, skill)`, which linear-scans the ~175-entry vocabulary AND compiles a
  // fresh RegExp per call — over ~1,600 candidates x ~15 required skills that was the largest
  // remaining cost in a ranking recompute. Always pass `profileSkillSet` from a hot path.
  const set = args.profileSkillSet;
  const has = (skill: string): boolean =>
    set
      ? set.has(skill.trim().toLowerCase())
      : profile.some((p) => p.toLowerCase() === skill.toLowerCase()) || hasSkill(profileBlob, skill);

  const matched = required.filter(has);
  const missing = required.filter((s) => !has(s));
  const missingInTitle = requiredInTitle.filter((s) => !has(s));

  let score: number;
  if (required.length === 0) {
    score = 0.5; // JD names nothing we recognise — stay neutral, don't punish or reward
  } else {
    // Weighted coverage: title requirements count twice.
    const weight = (s: string) => (requiredInTitle.includes(s) ? 2 : 1);
    const total = required.reduce((a, s) => a + weight(s), 0);
    const got = matched.reduce((a, s) => a + weight(s), 0);
    score = total > 0 ? got / total : 0.5;
  }

  return { required, matched, missing, missingInTitle, score: clamp01(score) };
}

export type ReasonKind = 'skill-match' | 'skill-gap' | 'domain' | 'role' | 'location' | 'freshness' | 'evaluation' | 'comp' | 'deal-breaker' | 'legitimacy' | 'duplicate';

export interface Reason {
  kind: ReasonKind;
  /** Short chip text, e.g. "FHIR ✓" or "Java ✗ not in your skills". */
  label: string;
  /** positive / negative / neutral — drives the chip colour. */
  tone: 'good' | 'bad' | 'neutral';
}

export interface CompositeInput {
  /** 0..1 fused lexical+vector retrieval score (RRF). */
  retrieval: number;
  skillFit: SkillFit;
  /** LLM evaluation overall_score on its native 1-5 scale, or null when not yet evaluated. */
  llmScore: number | null;
  llmRecommendation: 'apply' | 'consider' | 'skip' | null;
  /** Raw contextual terms, on their original small scales. */
  locationScore: number;
  freshnessScore: number;
  legitimacyPenalty: number;
  /** Hard constraints from the profile's targets, previously never read at ranking time. */
  dealBreakerHits: string[];
  missingMustHaves: string[];
  /** True when the posting states a salary below targets.comp_min. */
  belowCompFloor: boolean;
  domainHit: boolean;
  roleTargetHit: boolean;
  /**
   * Title-shape signal: negative for clearly non-technical postings (sales, recruiting, ...),
   * slightly positive for architect/lead titles. Originally computed in matches.ts and stored on
   * the row but NEVER passed into scoring, so non-technical postings quietly stopped being
   * down-ranked when the composite replaced the old additive model.
   */
  rolePenalty: number;
}

export interface CompositeResult {
  /** 0..100. Bounded by construction — no clamping artefact. */
  score: number;
  parts: {
    retrieval: number;
    skillFit: number;
    llmFit: number | null;
    context: number;
    weights: Record<string, number>;
    penalties: number;
    skillMatchFloor?: number | null;
    cap: number | null;
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Fold location / freshness / legitimacy into one 0..1 "context" signal centred on 0.5, so a
 * neutral posting neither gains nor loses. The multipliers convert their original small additive
 * scales (±0.05, ±0.20, ±0.30) into a meaningful share of one component.
 */
function contextScore(i: CompositeInput): number {
  // `rolePenalty` is on the same ±0.15 scale as the other additive terms, so it gets the same ×2
  // treatment: a sales/recruiting title loses 0.30 of the context component, an architect/lead
  // title gains 0.04.
  return clamp01(
    0.5 +
      i.locationScore * 2 +
      i.freshnessScore * 2 +
      i.legitimacyPenalty +
      i.rolePenalty * 2 +
      (i.domainHit ? 0.1 : 0) +
      (i.roleTargetHit ? 0.05 : 0),
  );
}

/**
 * The composite. Weights are explicit and sum to 1, so the output is genuinely bounded 0..100.
 * When a job has no LLM evaluation its 25% is redistributed to retrieval and skills rather than
 * scored as zero — otherwise every unevaluated job would be structurally capped at 75.
 */
export function scoreComposite(i: CompositeInput): CompositeResult {
  const evaluated = i.llmScore != null && Number.isFinite(i.llmScore);
  const llmFit = evaluated ? clamp01((Number(i.llmScore) - 1) / 4) : null;
  const ctx = contextScore(i);

  const weights = evaluated
    ? { retrieval: 0.40, skillFit: 0.25, llmFit: 0.25, context: 0.10 }
    : { retrieval: 0.55, skillFit: 0.35, llmFit: 0.00, context: 0.10 };

  const base =
    clamp01(i.retrieval) * weights.retrieval +
    i.skillFit.score * weights.skillFit +
    (llmFit ?? 0) * weights.llmFit +
    ctx * weights.context;

  // --- hard constraints: these are the user's stated non-negotiables, so they subtract or cap
  // rather than being averaged away by a strong cosine. ---
  let penalties = 0;
  // A required skill named in the TITLE that the candidate lacks is the Java case exactly.
  // Downranks without zeroing out genuine positive skill overlap.
  penalties += Math.min(0.16, i.skillFit.missingInTitle.length * 0.08);
  penalties += Math.min(0.15, i.missingMustHaves.length * 0.075);
  if (i.belowCompFloor) penalties += 0.12;

  let cap: number | null = null;
  if (i.dealBreakerHits.length > 0) cap = 15;
  if (i.legitimacyPenalty <= -0.30) cap = Math.min(cap ?? 100, 20);
  if (i.llmRecommendation === 'skip') cap = Math.min(cap ?? 100, 45);
  if (i.skillFit.missingInTitle.length > 0) cap = Math.min(cap ?? 100, 60);

  let rawScore = Math.round(clamp01(base - penalties) * 100);

  // When the candidate demonstrably matches required skills (e.g. Python ✓, SQL ✓),
  // uphold a skill match floor so a posting with positive matched skills is never
  // reported as a 0% match.
  let skillMatchFloor = 0;
  if (i.skillFit.matched.length > 0) {
    skillMatchFloor = Math.min(
      30,
      Math.round(i.skillFit.score * 50) + Math.min(15, i.skillFit.matched.length * 4)
    );
    rawScore = Math.max(rawScore, skillMatchFloor);
  }

  let score = rawScore;
  if (cap != null) score = Math.min(score, cap);

  return {
    score,
    parts: {
      retrieval: round3(i.retrieval),
      skillFit: round3(i.skillFit.score),
      llmFit: llmFit == null ? null : round3(llmFit),
      context: round3(ctx),
      weights,
      penalties: round3(penalties),
      skillMatchFloor: skillMatchFloor > 0 ? skillMatchFloor : null,
      cap,
    },
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Build the explanation chips. Ordered most-decisive first and capped, because the row has room
 * for about four. Negative reasons come first when they exist — the user's complaint was that a
 * bad match looked good, so the disqualifying fact must be the visible one.
 */
export function buildReasons(args: {
  fit: SkillFit;
  composite: CompositeResult;
  input: CompositeInput;
  locationBadge: string;
  locationReason: string;
  ageDays: number | null;
  duplicateCount: number;
}): Reason[] {
  const { fit, input } = args;
  const bad: Reason[] = [];
  const good: Reason[] = [];

  for (const db of input.dealBreakerHits.slice(0, 2)) {
    bad.push({ kind: 'deal-breaker', label: `${db} — deal-breaker`, tone: 'bad' });
  }
  for (const s of fit.missingInTitle.slice(0, 2)) {
    const g = skillGroup(s);
    bad.push({ kind: 'skill-gap', label: g === 'language' || g === 'runtime' ? `${s} ✗ not your stack` : `${s} ✗ not in your skills`, tone: 'bad' });
  }
  for (const m of input.missingMustHaves.slice(0, 2)) {
    bad.push({ kind: 'skill-gap', label: `no ${m}`, tone: 'bad' });
  }
  if (input.belowCompFloor) bad.push({ kind: 'comp', label: 'below your comp floor', tone: 'bad' });
  if (input.legitimacyPenalty <= -0.30) bad.push({ kind: 'legitimacy', label: 'looks suspicious', tone: 'bad' });
  if (args.locationBadge === 'us-only') bad.push({ kind: 'location', label: 'US-only', tone: 'bad' });

  // Positives: lead with the skills the candidate actually has that the JD asked for, since
  // that is the question "why is this a match?" really means.
  for (const s of fit.matched.slice(0, 3)) {
    good.push({ kind: 'skill-match', label: `${s} ✓`, tone: 'good' });
  }
  if (input.llmRecommendation === 'apply') good.push({ kind: 'evaluation', label: 'AI: apply', tone: 'good' });
  if (args.locationBadge === 'india' || args.locationBadge === 'remote-global') {
    good.push({ kind: 'location', label: args.locationBadge === 'india' ? 'India' : 'Remote · global', tone: 'good' });
  }
  // `domain` and `role` were declared in `ReasonKind` and NEVER emitted, so two signals that do
  // affect the score had no way to explain themselves on a row. `domainHit` is the résumé-derived
  // focus-area boost (this is the "In focus" signal, which lost its per-row chip when `reasons[]`
  // replaced the old badges) and `roleTargetHit` is a match against a target role the user curated
  // on /profile — the single most direct answer to "why is this in my list?".
  if (input.domainHit) good.push({ kind: 'domain', label: 'In focus', tone: 'good' });
  if (input.roleTargetHit) good.push({ kind: 'role', label: 'Target role', tone: 'good' });

  const neutral: Reason[] = [];
  if (args.ageDays != null) {
    neutral.push({ kind: 'freshness', label: formatAge(args.ageDays), tone: args.ageDays <= 14 ? 'good' : args.ageDays > 90 ? 'bad' : 'neutral' });
  }
  if (args.duplicateCount > 1) {
    neutral.push({ kind: 'duplicate', label: `${args.duplicateCount} locations`, tone: 'neutral' });
  }

  return [...bad, ...good, ...neutral].slice(0, 5);
}

export function formatAge(days: number): string {
  if (days <= 0) return 'posted today';
  if (days === 1) return 'posted 1d ago';
  if (days < 30) return `posted ${Math.round(days)}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `posted ${months}mo ago`;
  const years = (days / 365).toFixed(years0(days));
  return `posted ${years}y ago`;
}
function years0(days: number): number {
  return days / 365 >= 10 ? 0 : 1;
}

/** Free-text `must_haves` / `deal_breakers` are comma/newline separated in the profile. */
export function splitTerms(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** Which of `terms` appear in the posting text. */
export function termsPresent(text: string, terms: string[]): string[] {
  if (!terms.length) return [];
  return terms.filter((t) => hasSkill(text, t));
}

/** Which of `terms` are absent from the posting text. */
export function termsAbsent(text: string, terms: string[]): string[] {
  if (!terms.length) return [];
  return terms.filter((t) => !hasSkill(text, t));
}
