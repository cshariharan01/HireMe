import { describe, it, expect } from 'vitest';
import { scoreComposite, analyzeSkillFit, buildProfileSkillSet, buildReasons, pruneSubsumedSkills } from '@/lib/relevance';
import { scoreTier, pctClamp } from '@/lib/score';
import { hasSkill } from '@/lib/skills-vocab';

/** A neutral baseline so each test varies exactly one signal. */
function base(over: Partial<Parameters<typeof scoreComposite>[0]> = {}) {
  return {
    retrieval: 0.6,
    skillFit: { score: 0.6, required: ['FHIR'], matched: ['FHIR'], missing: [], missingInTitle: [] },
    llmScore: null,
    llmRecommendation: null,
    locationScore: 0,
    freshnessScore: 0,
    legitimacyPenalty: 0,
    dealBreakerHits: [],
    missingMustHaves: [],
    belowCompFloor: false,
    domainHit: false,
    roleTargetHit: false,
    rolePenalty: 0,
    ...over,
  } as Parameters<typeof scoreComposite>[0];
}

describe('composite score is bounded and ordered', () => {
  it('never exceeds 100 or drops below 0', () => {
    const best = scoreComposite(base({
      retrieval: 1, skillFit: { score: 1, required: ['FHIR'], matched: ['FHIR'], missing: [], missingInTitle: [] },
      llmScore: 5, llmRecommendation: 'apply', locationScore: 0.05, freshnessScore: 0.05,
      domainHit: true, roleTargetHit: true, rolePenalty: 0.02,
    }));
    const worst = scoreComposite(base({
      retrieval: 0, skillFit: { score: 0, required: ['Java'], matched: [], missing: ['Java'], missingInTitle: ['Java'] },
      llmScore: 1, llmRecommendation: 'skip', locationScore: -0.2, freshnessScore: -0.1,
      legitimacyPenalty: -0.3, belowCompFloor: true, rolePenalty: -0.15,
    }));
    expect(best.score).toBeLessThanOrEqual(100);
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(best.score).toBeGreaterThan(worst.score);
  });

  it('a deal-breaker caps the score regardless of how good everything else is', () => {
    const r = scoreComposite(base({
      retrieval: 1,
      skillFit: { score: 1, required: ['FHIR'], matched: ['FHIR'], missing: [], missingInTitle: [] },
      llmScore: 5, llmRecommendation: 'apply',
      dealBreakerHits: ['on-site only'],
    }));
    expect(r.score).toBeLessThanOrEqual(15);
  });

  it('an AI "skip" caps the score', () => {
    const r = scoreComposite(base({ retrieval: 1, llmScore: 5, llmRecommendation: 'skip' }));
    expect(r.score).toBeLessThanOrEqual(45);
  });

  it('unevaluated jobs are not structurally capped by the missing LLM weight', () => {
    // Redistribution matters: without it every unrated job would top out at 75.
    const unrated = scoreComposite(base({ retrieval: 1, skillFit: { score: 1, required: ['FHIR'], matched: ['FHIR'], missing: [], missingInTitle: [] } }));
    expect(unrated.score).toBeGreaterThan(75);
  });
});

describe('rolePenalty actually reaches the score', () => {
  /**
   * REGRESSION: `getRolePenalty` was computed in matches.ts, stored on the row, and never passed to
   * `scoreComposite` — so non-technical postings silently stopped being down-ranked when the
   * composite replaced the old additive model.
   */
  it('a non-technical title scores lower than an identical technical one', () => {
    const technical = scoreComposite(base({ rolePenalty: 0 }));
    const sales = scoreComposite(base({ rolePenalty: -0.15 }));
    expect(sales.score).toBeLessThan(technical.score);
  });

  it('an architect/lead title scores at least as high as a neutral one', () => {
    const neutral = scoreComposite(base({ rolePenalty: 0 }));
    const architect = scoreComposite(base({ rolePenalty: 0.02 }));
    expect(architect.score).toBeGreaterThanOrEqual(neutral.score);
  });
});

describe('skill matching uses word boundaries', () => {
  /** `Java` must not match `JavaScript` — the defect that scored a Java architect 98% for a
   *  candidate who had only ever written JavaScript. */
  it('Java does not match JavaScript', () => {
    expect(hasSkill('We need a JavaScript developer', 'Java')).toBe(false);
    expect(hasSkill('Deep Java and Spring Boot experience', 'Java')).toBe(true);
  });

  it('single-letter skills are excluded (C must not match the C in C-CDA)', () => {
    // A bare `C` skill would match "C-CDA", a healthcare document standard, on every posting.
    const profileSkills = ['FHIR', 'HL7'];
    const fit = analyzeSkillFit({
      jobTitle: 'Integration Architect',
      jobDescription: 'Experience with C-CDA and FHIR required',
      profileSkills,
      profileSkillSet: buildProfileSkillSet(profileSkills),
    });
    // The vocabulary canonicalises FHIR to "HL7 FHIR", so assert on the canonical entry.
    expect(fit.matched.some((m) => /FHIR/i.test(m))).toBe(true);
    // The real point: a bare single-letter "C" must never be extracted from "C-CDA".
    expect(fit.required).not.toContain('C');
    expect(fit.required.some((r) => r.trim().length === 1)).toBe(false);
  });

  it('a missing title skill is reported in missingInTitle', () => {
    const profileSkills = ['FHIR', 'HL7'];
    const fit = analyzeSkillFit({
      jobTitle: 'Java Solution Architect',
      jobDescription: 'Java microservices at scale',
      profileSkills,
      profileSkillSet: buildProfileSkillSet(profileSkills),
    });
    expect(fit.missingInTitle.length).toBeGreaterThan(0);
    expect(fit.score).toBeLessThan(0.5);
  });
});

describe('score tiers discriminate across the real distribution', () => {
  /**
   * REGRESSION: the inherited 80/65/50 thresholds put 95.1% of the corpus in "low" (3 of 1,006 rows
   * reached "high"), so every filtered view rendered as an undifferentiated wall of grey.
   * Thresholds are now the p95/p85/p50 points of the measured distribution.
   */
  it('assigns the four tiers at the calibrated cut-offs', () => {
    expect(scoreTier(0.86)).toBe('high');
    expect(scoreTier(0.55)).toBe('high');
    expect(scoreTier(0.54)).toBe('good');
    expect(scoreTier(0.45)).toBe('good');
    expect(scoreTier(0.44)).toBe('fair');
    expect(scoreTier(0.33)).toBe('fair');
    expect(scoreTier(0.32)).toBe('low');
  });

  it('the median of the measured corpus is NOT "low"', () => {
    // Measured median was 32; a median job landing in the bottom tier is what caused the complaint.
    expect(scoreTier(0.33)).not.toBe('low');
  });

  it('pctClamp keeps values in 0..100', () => {
    expect(pctClamp(1.5)).toBe(100);
    expect(pctClamp(-1)).toBe(0);
    expect(pctClamp(0.86)).toBe(86);
  });
});

describe('every declared reason kind can actually be emitted', () => {
  /**
   * REGRESSION: `ReasonKind` declared 'domain' and 'role' but `buildReasons` never produced them,
   * so two signals that DO move the score had no way to explain themselves on a row — the "In
   * focus" chip silently disappeared when `reasons[]` replaced the old badges.
   */
  const args = (over: Record<string, unknown> = {}) => ({
    fit: { score: 0.6, required: ['FHIR'], matched: ['FHIR'], missing: [], missingInTitle: [] },
    composite: scoreComposite(base()),
    input: base({ domainHit: true, roleTargetHit: true, ...over }),
    locationBadge: 'remote-neutral' as const,
    locationReason: '',
    ageDays: 3,
    duplicateCount: 1,
  });

  it('emits an "In focus" chip when the domain boost fired', () => {
    const reasons = buildReasons(args() as never);
    expect(reasons.some((r) => r.kind === 'domain')).toBe(true);
  });

  it('emits a "Target role" chip when a curated role matched', () => {
    const reasons = buildReasons(args() as never);
    expect(reasons.some((r) => r.kind === 'role')).toBe(true);
  });

  it('emits neither when the signals did not fire', () => {
    const reasons = buildReasons(args({ domainHit: false, roleTargetHit: false }) as never);
    expect(reasons.some((r) => r.kind === 'domain' || r.kind === 'role')).toBe(false);
  });
});

describe('positive matched skills never score 0', () => {
  it('upholds a skill match floor when candidate matches required skills despite missing title skills', () => {
    // Exact scenario from user report:
    // Data Engineer - Azure data factory: candidate matches Python & SQL, but lacks Azure Data Factory in title.
    const result = scoreComposite(base({
      retrieval: 0.05,
      skillFit: {
        score: 0.18,
        required: ['Azure Data Factory', 'Python', 'SQL', 'Databricks'],
        matched: ['Python', 'SQL'],
        missing: ['Azure Data Factory', 'Databricks'],
        missingInTitle: ['Azure Data Factory'],
      },
      locationScore: 0.05,
      freshnessScore: 0.02,
      rolePenalty: 0.02,
    }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThanOrEqual(15);
  });

  it('prunes subsumed sub-skills when longer skill contains them', () => {
    expect(pruneSubsumedSkills(['Azure Data Factory', 'Azure'], 'Data Engineer - Azure data factory')).toEqual(['Azure Data Factory']);
    expect(pruneSubsumedSkills(['React Native', 'React'], 'React Native Developer')).toEqual(['React Native']);
    expect(pruneSubsumedSkills(['Azure DevOps', 'Azure'], 'Azure Architect with Azure DevOps')).toEqual(['Azure DevOps', 'Azure']);
  });
});
