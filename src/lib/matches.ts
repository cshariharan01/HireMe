import db, { jobFtsAvailable } from './db';
import { blobToEmbedding, embeddingToBlob, generateEmbedding } from './embeddings';
import { getDomainBoost } from './ontology';
import { extractPostingFacts, type PostingFacts } from './posting-facts';
import {
  analyzeSkillFit,
  buildProfileSkillSet,
  buildReasons,
  scoreComposite,
  splitTerms,
  termsAbsent,
  termsPresent,
  type CompositeResult,
  type Reason,
} from './relevance';
import { canonicalizeSkill, findSkills } from './skills-vocab';

// Shared match-ranking engine + read-through cache.
//
// The heavy work — a brute-force `vec_distance_cosine` scan over all embedded jobs plus a
// per-candidate JS re-rank — used to run on EVERY `/api/matches` request (and a second scan on
// `/api/digest`). This module runs it at most once per "state", caching the full ranked list in
// the `match_cache` table keyed by a cheap signature. `/api/matches`, `/api/matches/[jobId]`, and
// `/api/digest` all read from here, so a page load does one scan (on a cold cache) instead of two,
// and repeat loads / pagination do zero.

interface JobRow {
  id: number;
  company: string;
  title: string;
  location: string;
  url: string;
  description: string;
  domain_priority: number;
  remote_policy: string | null;
  visa_sponsorship: number;
  relocation_offered: number;
  apply_type: string | null;
  source: string;
  source_platform: string | null;
  distance: number;
  ingested_at: string;
  last_seen_at: string | null;
  posted_at: string | null;
  url_status: string | null;
  expired_at: string | null;
  eval_overall: number | null;
  eval_recommendation: string | null;
  hidden_at: string | null;
  application_status: string | null;
}

interface ProfileRow {
  id: number;
  parsed_json: string;
  embedding: Buffer;
}

export type LegitimacySignal = 'verified' | 'unknown' | 'caution' | 'suspicious';
export type RoleArchetype = 'Architect' | 'Engineer' | 'Lead' | 'Product' | 'Solutions' | 'Data' | 'DevOps' | 'Other';
type LocationBadge = 'india' | 'remote-global' | 'relocation' | 'visa' | 'remote-neutral' | 'us-city' | 'us-only';

export interface RankedMatch {
  id: number;
  company: string;
  title: string;
  location: string;
  url: string;
  source: string;
  ingestedAt: string;
  postedAt?: string | null;
  domainPriority: number;
  remotePolicy: string | null;
  visaSponsorship: boolean;
  relocationOffered: boolean;
  applyType: 'easy_apply' | 'direct_apply' | 'external' | 'unknown';
  sourcePlatform?: string | null;
  facts: PostingFacts;
  locationBadge: LocationBadge;
  locationReason: string;
  archetype: RoleArchetype;
  ontologyBoost: number;
  rolePenalty: number;
  /**
   * 0..1, and it is exactly `score / 100`. Kept as the sort key and for existing consumers
   * (`pctClamp(finalScore)` in ScoreBadge / the detail panel) so they render the new bounded
   * score without changes. It is NO LONGER "cosine + boosts" — see `score`.
   */
  finalScore: number;
  /**
   * The headline 0-100 fit score from `scoreComposite`. Bounded by construction: a weighted mix
   * of retrieval, skill overlap, LLM verdict and context, then hard constraints. Replaces the old
   * `round((cosine + stacked boosts) * 100)`, which overflowed past 1.0 and was clamped to 100 —
   * that clamp made seven unrelated jobs all display "100%".
   */
  score: number;
  /** Fused lexical(BM25) + vector rank, 0..1. */
  /** What the JD asks for vs what the résumé has — the signal that did not exist before. */
  skillFit: { required: string[]; matched: string[]; missing: string[]; missingInTitle: string[]; score: number };
  /** Chips explaining the score, negatives first. */
  reasons: Reason[];
  /** Component breakdown, so a surprising score is debuggable. */
  /** Age of the posting in days (posted_at, else last_seen_at, else ingested_at). */
  ageDays: number | null;
  /** Other rows that are the same role at a different location, collapsed into this one. */
  variants: Array<{ id: number; location: string }>;
  evaluation: { overall_score: number | null; recommendation: 'apply' | 'consider' | 'skip' } | null;
  legitimacy: LegitimacySignal;
  legitimacyReason: string;
  hidden: boolean;
  // Application state — surfaced so the dashboard can badge / hide jobs you've already applied to.
  applied: boolean;
  applicationStatus: 'applied' | 'screening' | 'interview' | 'offer' | 'rejected' | null;
  gapAnalysis: { matchedSkills: string[]; missingKeywords: string[] };
}

export interface RankedResult {
  ranked: RankedMatch[];
  totalEmbedded: number;
  hiddenCount: number;
}

// Recency weighting: fresher postings rank higher, stale ones lower. Small relative to
// cosine so it nudges rather than dominates. Tolerates null/garbage dates (→ 0).
function freshnessScore(dateStr: string | null): number {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageDays = (Date.now() - t) / 86_400_000;
  if (ageDays < 0) return 0;      // future/clock skew
  if (ageDays <= 7) return 0.05;
  if (ageDays <= 30) return 0.02;
  if (ageDays <= 90) return 0;
  return -0.10;                   // >90 days — likely filled/dead
}

// Heuristic posting-level legitimacy. Cheap: derived from age + JD quality patterns.
// Different from company-level legitimacy in the brief (which uses LLM judgement).
function classifyLegitimacy(args: {
  ingestedAt: string;
  description: string;
  title: string;
  source: string;
}): { signal: LegitimacySignal; reason: string } {
  const ageDays = Math.floor((Date.now() - new Date(args.ingestedAt).getTime()) / 86_400_000);
  const desc = args.description || '';
  const descLen = desc.length;
  const title = args.title || '';

  // Suspicious patterns first — strongest signals
  if (/\$\$\$|earn (?:money|cash)|work from home|easy money|no experience needed|guaranteed income/i.test(title + ' ' + desc)) {
    return { signal: 'suspicious', reason: 'Spam-like patterns in title or description' };
  }
  if (/^\$|\d+k\/week\b|click here to apply|whatsapp|telegram\b/i.test(title)) {
    return { signal: 'suspicious', reason: 'Title contains red-flag patterns' };
  }

  // Caution patterns
  if (descLen < 100) {
    return { signal: 'caution', reason: `Very short description (${descLen} chars)` };
  }
  if (ageDays > 90) {
    return { signal: 'caution', reason: `Stale — ingested ${ageDays} days ago` };
  }
  if (descLen < 300 && ageDays > 30) {
    return { signal: 'caution', reason: `Thin description (${descLen} chars), ingested ${ageDays}d ago` };
  }

  // Verified-ish — positive signals (specific tech / numbers / named people / structured JD)
  const hasStructure = /\b(responsibilities|requirements|qualifications|what you.ll do|about (the|this) role)\b/i.test(desc);
  const hasSpecificTech = (desc.match(/\b(FHIR|HL7|Kubernetes|Docker|Terraform|Postgres|TypeScript|Python|Java|Go|Rust|React|Angular|Node\.js|AWS|Azure|GCP|Snowflake|Databricks|Kafka|Redis)\b/gi) || []).length;
  if (descLen >= 800 && hasStructure && hasSpecificTech >= 3 && ageDays <= 30) {
    return { signal: 'verified', reason: `Well-structured ${descLen}-char JD with ${hasSpecificTech}+ specific tech mentions, fresh` };
  }

  return { signal: 'unknown', reason: `${descLen}-char JD, ${ageDays}d old` };
}

// Role-level keywords that indicate seniority alignment for architect/lead profiles
const ARCHITECT_ROLE_KEYWORDS = [
  'architect', 'lead', 'senior', 'principal', 'staff', 'director',
  'manager', 'engineering', 'developer', 'engineer', 'technical',
  'integration', 'platform', 'infrastructure', 'devops', 'solutions',
  'data engineer', 'software engineer', 'full stack',
];

const NON_TECHNICAL_ROLES = [
  'account executive', 'sales', 'customer success', 'recruiter',
  'marketing', 'copywriter', 'content', 'design', 'graphic',
  'hr ', 'human resources', 'receptionist', 'administrative',
  'analyst, customer', 'customer growth', 'customer insights',
  'accountant', 'revenue accountant', 'medical coder', 'billing',
  'collection', 'fp&a', 'finance', 'financial analyst', 'legal',
  'compliance officer', 'country head', 'denial management',
  'rejection management', 'operations manager',
];

interface LocationAssessment {
  score: number;
  badge: LocationBadge;
  reason: string;
}

export const INDIA_LOCATIONS_REGEX = /\b(india|bengaluru|bangalore|mumbai|bombay|delhi|new delhi|ncr|gurugram|gurgaon|noida|hyderabad|secunderabad|chennai|madras|pune|kolkata|calcutta|ahmedabad|kochi|cochin|thiruvananthapuram|trivandrum|karnataka|maharashtra|telangana|tamil nadu|tamilnadu|kerala|haryana|uttar pradesh|chandigarh|jaipur|indore)\b/i;

const REMOTE_KEYWORD_REGEX = /\b(remote|work from home|wfh|worldwide|anywhere|global)\b/i;

// Score a job's compatibility with the user's location. Does NOT filter —
// the matcher surfaces everything and lets the user decide, because a US-city job
// can still hire Indians as contractors, offer relocation, or route through an India office.
function getLocationAssessment(
  jobLocation: string,
  profileLocation: string,
  remotePolicy: string | null,
  visaSponsorship: boolean,
  relocationOffered: boolean,
  jobTitle?: string,
): LocationAssessment {
  const loc = (jobLocation || '').toLowerCase();
  const title = (jobTitle || '').toLowerCase();
  const prof = (profileLocation || '').toLowerCase();
  const indiaUser = prof.includes('india');

  // If user isn't India-based, skip location-specific scoring
  if (!indiaUser) return { score: 0, badge: 'remote-neutral', reason: 'non-india profile' };

  const isIndia = INDIA_LOCATIONS_REGEX.test(loc);
  const mentionsRemote = REMOTE_KEYWORD_REGEX.test(loc) || REMOTE_KEYWORD_REGEX.test(title);

  // 1. Strongest positive for India user: in-office or hybrid physical India role
  if (isIndia && !mentionsRemote) {
    return { score: 0.05, badge: 'india', reason: 'India-located' };
  }

  // 2. India role that is explicitly remote
  if (isIndia && mentionsRemote) {
    return { score: 0.05, badge: 'remote-global', reason: 'Remote (India)' };
  }

  // 3. Remote-global (worldwide, work from anywhere, or classifier global absent US restrictions)
  if (remotePolicy === 'global' && !loc.includes('usa') && !loc.includes('us ')) {
    return { score: 0.05, badge: 'remote-global', reason: 'Remote (global)' };
  }
  if (/\b(anywhere|worldwide|global)\b/i.test(loc) && !loc.includes('usa') && !loc.includes('us ')) {
    return { score: 0.05, badge: 'remote-global', reason: 'Worldwide/anywhere' };
  }

  // 4. Visa sponsorship or relocation — viable even if US-located
  if (visaSponsorship) return { score: 0.03, badge: 'visa', reason: 'Visa sponsorship available' };
  if (relocationOffered) return { score: 0.03, badge: 'relocation', reason: 'Relocation offered' };

  // 5. Explicit US-only hard restriction (from classifier)
  if (remotePolicy === 'us-only') return { score: -0.20, badge: 'us-only', reason: 'US-only (per posting)' };

  // 6. Generic/unspecified Remote without country qualifier
  if (loc === 'remote' || (/\bremote\b/i.test(loc) && !loc.includes('usa') && !loc.includes('us-')) || mentionsRemote) {
    return { score: 0, badge: 'remote-neutral', reason: 'Remote (unspecified)' };
  }

  // 7. US city without remote-global / visa / relocation markers — penalize but keep visible.
  // Matches common city names, ", XX" 2-letter state code (Mountain View, CA), or plain "United States"/"USA".
  const usCityName = /\b(boston|nyc|new york|san francisco|seattle|austin|chicago|denver|atlanta|dallas|los angeles|portland|charlotte|phoenix|nashville|raleigh|miami|minneapolis|tampa|pittsburgh|salt lake|washington|leesburg|kansas city|houston|san diego|philadelphia|mountain view|palo alto|san jose|san mateo|sunnyvale|redwood city|berkeley|oakland|bellevue|redmond|boulder|ann arbor|research triangle|rtp|durham|chapel hill)\b/i.test(loc);
  const usStateCode = /,\s*[A-Z]{2}\b/.test(jobLocation || '') && !isIndia;
  const usCountry = /^(usa|us|united states)$/i.test(loc.trim()) || /\b(united states|usa)\b/i.test(loc);
  if (usCityName || usStateCode || usCountry) return { score: -0.10, badge: 'us-city', reason: 'US-located (no remote/visa/relo noted)' };

  // 8. International / Non-India onsite or unknown
  return { score: -0.10, badge: 'us-city', reason: 'Non-India located' };
}

function getRolePenalty(jobTitle: string): number {
  const titleLower = (jobTitle || '').toLowerCase();

  // Penalize clearly non-technical roles
  for (const role of NON_TECHNICAL_ROLES) {
    if (titleLower.includes(role)) return -0.15;
  }

  // Boost roles that align with architect/lead/senior engineering
  for (const keyword of ARCHITECT_ROLE_KEYWORDS) {
    if (titleLower.includes(keyword)) return 0.02;
  }

  return 0;
}

// Role archetype — coarse classification from title alone. First match wins.
// Used for dashboard filtering, not scoring.
const ARCHETYPE_PATTERNS: Array<{ archetype: RoleArchetype; pattern: RegExp }> = [
  { archetype: 'Architect', pattern: /\b(architect|principal|staff engineer|fellow|distinguished engineer)\b/i },
  { archetype: 'Lead', pattern: /\b(engineering manager|tech lead|team lead|head of (engineering|platform|tech|product|data)|vp(\b| of)|director of (engineering|platform|tech|data)|cto|cio)\b/i },
  { archetype: 'Product', pattern: /\b(product manager|product owner|group product|director of product|head of product|chief product)\b/i },
  { archetype: 'Solutions', pattern: /\b(solutions? engineer|customer success|sales engineer|implementation (engineer|consultant)|technical account manager|forward deployed)\b/i },
  { archetype: 'Data', pattern: /\b(data engineer|data scientist|machine learning|ml engineer|ai engineer|data analyst|analytics engineer|llm)\b/i },
  { archetype: 'DevOps', pattern: /\b(devops|sre|site reliability|platform engineer|infrastructure engineer|reliability engineer|cloud engineer)\b/i },
  { archetype: 'Engineer', pattern: /\b(engineer|developer|programmer|swe|sde|backend|frontend|full[- ]?stack)\b/i },
];
function classifyArchetype(title: string): RoleArchetype {
  for (const { archetype, pattern } of ARCHETYPE_PATTERNS) {
    if (pattern.test(title)) return archetype;
  }
  return 'Other';
}

// Final ranked-list size held in the cache. Fixed (not paged) so the cached list supports
// pagination AND server-side filtering without recompute.
//
// Raised from 500 to 1200 when filtering moved server-side: the filters now run over this pool, so
// its depth is what decides whether a chip like "Visa" or "US city" can return anything at all.
// At 500 those chips were usually empty. Cache payload is ~1.4MB of JSON, which is nothing for a
// single-user SQLite app, and it is written once per state change.
const POOL = 1200;
// Candidate depth per retrieval leg before fusion. Deeper than POOL so a job that only one leg
// likes still gets a chance to be scored.
const RETRIEVE = 800;
// Reciprocal Rank Fusion constant. 60 is the value from the original RRF paper and the de-facto
// default; it damps the difference between rank 1 and rank 5 so neither leg dominates.
const RRF_K = 60;
// At most this many rows from one company in the returned list. The top 100 previously contained
// only 77 distinct companies (Databricks x6, Cohere Health x5), which is what "same jobs show up
// most of the time" felt like.
const MAX_PER_COMPANY = 3;

interface RankOpts {
  includeHidden: boolean;
  includeExpired: boolean;
  /** Applied jobs are excluded by DEFAULT now — they belong in /tracker, not the active list. */
  includeApplied?: boolean;
  refresh?: boolean;
  /**
   * Return null rather than computing when this pool has no usable cached payload, and fill it in
   * the background instead. For SECONDARY lookups that must never block a page render — e.g. the
   * detail route's fallback pool, which is only consulted for a hidden/expired/applied job. That
   * fallback was measured adding a consistent 4.5s to the detail route because its pool had never
   * been computed, and a missing fit score is a far smaller problem than a 4.5s page.
   */
  cachedOnly?: boolean;
  /** Specific job to unconditionally include and score even if outside default retrieval/filter */
  includeJobId?: number;
}

function cacheKey(o: RankOpts): string {
  return `${o.includeHidden ? 'h' : '-'}${o.includeExpired ? 'e' : '-'}${o.includeApplied ? 'a' : '-'}`;
}

/**
 * Build the FTS5 MATCH expression from the candidate's own vocabulary: enabled target roles,
 * résumé skills, and derived domain terms. This is the lexical half of hybrid retrieval — it is
 * what makes "FHIR" and "HL7" actually count as terms rather than being averaged into a document
 * embedding where "Java architect" and "FHIR architect" look nearly identical.
 *
 * Every term is quoted, so FTS5 treats it as a phrase and punctuation inside it (C++, .NET,
 * Node.js) cannot be parsed as query syntax. Double quotes are stripped for the same reason.
 */
function buildFtsQuery(terms: string[]): string | null {
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const raw of terms) {
    const t = raw.replace(/"/g, ' ').trim().toLowerCase();
    // FTS5 chokes on empty phrases, and a 1-char term matches far too much to be useful.
    if (t.length < 2) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    phrases.push(`"${t}"`);
    if (phrases.length >= 60) break; // keep the query bounded; measured ~10-30ms at this size
  }
  return phrases.length ? phrases.join(' OR ') : null;
}

// Cheap fingerprint of everything that changes the ranked list. If it's unchanged since the
// cache was written, the cached payload is still valid. Two aggregate scans + one PK lookup —
// far cheaper than the vector scan + re-rank they guard.
function computeSignature(o: RankOpts): string {
  const p = db.prepare('SELECT updated_at FROM my_profile WHERE id = 1').get() as { updated_at: string } | undefined;
  const j = db.prepare(
    `SELECT COUNT(embedding) e, MAX(ingested_at) mi, MAX(last_seen_at) ml,
            COUNT(hidden_at) h, MAX(hidden_at) mh,
            COUNT(expired_at) x, MAX(expired_at) mx, MAX(url_checked_at) mu
     FROM job_postings`
  ).get() as Record<string, string | number | null>;
  const applyTypes = db.prepare(
    `SELECT COALESCE(apply_type, 'unknown') AS type, COUNT(*) AS count
     FROM job_postings
     GROUP BY COALESCE(apply_type, 'unknown')
     ORDER BY type`,
  ).all() as Array<{ type: string; count: number }>;
  const ev = db.prepare('SELECT COUNT(*) c, MAX(computed_at) m FROM job_evaluations').get() as { c: number; m: string | null };
  // Applications too — applying to / changing a job's status must re-badge it in the list.
  const ap = db.prepare('SELECT COUNT(*) c, MAX(last_status_change_at) m, MAX(applied_at) a FROM my_applications').get() as { c: number; m: string | null; a: string | null };
  return [
    o.includeHidden, o.includeExpired, o.includeApplied ?? false,
    // Bumped whenever the scoring model changes, so an old cached payload built by the previous
    // formula is never served. Without this, switching to the composite score would leave stale
    // "99%" rows in place until some unrelated count happened to change.
    SCORING_VERSION,
    // POOL too: server-side filtering runs over the cached pool, so growing it must invalidate.
    // (Caught in testing: raising POOL 500 -> 1200 had no effect until the cache was busted.)
    POOL,
    p?.updated_at ?? '', j.e, j.mi, j.ml, j.h, j.mh, j.x, j.mx, j.mu,
    JSON.stringify(applyTypes), ev.c, ev.m, ap.c, ap.m, ap.a,
  ].join('|');
}

// v2 = hybrid retrieval (BM25 + vector via RRF) + bounded composite score + skill fit.
// v1 was `cosine + stacked boosts` clamped to 100.
const SCORING_VERSION = 'score-v9-jd-experience';

// The heavy path — runs only on a cold/stale cache. Returns null when there is no usable profile.
// `profileOverride` lets a caller re-rank the pool against a DIFFERENT profile — specifically an
// AI-tailored résumé — without touching the persisted cache: `computeRanked` by itself never
// persists (only `getRankedMatches` does), so an override run is purely a private look.
function computeRanked(o: RankOpts, profileOverride?: ProfileRow | null): RankedResult | null {
  const profile =
    profileOverride ??
    (db.prepare('SELECT * FROM my_profile WHERE id = 1').get() as ProfileRow | undefined);
  if (!profile || !profile.embedding) return null;

  const parsedProfile = JSON.parse(profile.parsed_json);
  const profileSkills: string[] = parsedProfile.skills || [];
  const profileLocation: string = parsedProfile.location || '';

  // Adaptive role targeting ("Hunt + rank"): enabled target roles give a small soft boost to
  // jobs whose title matches — never a hard filter, so breadth is preserved.
  const targetRoles: string[] = Array.isArray(parsedProfile.targets?.roles) ? parsedProfile.targets.roles : [];
  const domainTerms: string[] = Array.isArray(parsedProfile.domain_terms) ? parsedProfile.domain_terms : [];
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word-boundary matching with light plural normalisation. The old version was a raw substring
  // test, so a target of "Solution Architect" did NOT match the title "Solutions Architect" — the
  // boost silently never fired for the user's most common target. `s?` handles that pair, and \b
  // stops a role name matching inside a longer word.
  // Each word may carry an optional trailing "s", so "Solution Architect" also matches
  // "Solutions Architect" (and vice versa). Whitespace is flexible for the same reason.
  const rolePattern = (r: string): string =>
    r
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `${escapeRegex(w)}s?`)
      .join('\\s+');
  const targetRoleRe = targetRoles.length
    ? new RegExp(`\\b(?:${targetRoles.map((r) => r.trim()).filter(Boolean).map(rolePattern).join('|')})\\b`, 'i')
    : null;

  // --- targets that were written by /profile but NEVER read at ranking time until now ---
  const targets = parsedProfile.targets || {};
  const mustHaves = splitTerms(targets.must_haves);
  const dealBreakers = splitTerms(targets.deal_breakers);
  const targetLocations: string[] = Array.isArray(targets.locations) ? targets.locations.filter(Boolean) : [];
  const compMin = Number(targets.comp_min);
  const hasCompFloor = Number.isFinite(compMin) && compMin > 0;

  // Built ONCE per run — see analyzeSkillFit.profileSkillSet. Doing this per job was the single
  // largest remaining cost in a recompute (a 175-entry linear scan + RegExp compile per skill).
  const profileSkillSet = buildProfileSkillSet(profileSkills);

  const profileEmbedding = blobToEmbedding(profile.embedding);
  const queryBlob = Buffer.from(profileEmbedding.buffer, profileEmbedding.byteOffset, profileEmbedding.byteLength);
  const hiddenFilter = o.includeHidden ? '' : ' AND j.hidden_at IS NULL';
  const expiredFilter = o.includeExpired ? '' : " AND j.expired_at IS NULL AND (j.url_status IS NULL OR j.url_status != 'dead')";
  // Applied jobs leave the active list entirely (not just get badged), so the page BACKFILLS with
  // real candidates. Previously `applied` was decoration only and the client hid them from an
  // already-truncated 30 rows, which made the list shorter instead of better.
  const appliedFilter = o.includeApplied
    ? ''
    : ' AND NOT EXISTS (SELECT 1 FROM my_applications a WHERE a.job_id = j.id)';
  const rowFilters = `${hiddenFilter}${expiredFilter}${appliedFilter}`;

  // ---------------- leg 1: vector (semantic) ----------------
  const vectorLeg = db.prepare(`
    SELECT j.id, vec_distance_cosine(j.embedding, ?) AS distance
    FROM job_postings j
    WHERE j.embedding IS NOT NULL${rowFilters}
    ORDER BY distance ASC
    LIMIT ?
  `).all(queryBlob, RETRIEVE) as Array<{ id: number; distance: number }>;

  if (o.includeJobId && !vectorLeg.some((r) => r.id === o.includeJobId)) {
    const explicitRow = db
      .prepare('SELECT j.id, vec_distance_cosine(j.embedding, ?) AS distance FROM job_postings j WHERE j.id = ? AND j.embedding IS NOT NULL')
      .get(queryBlob, o.includeJobId) as { id: number; distance: number } | undefined;
    if (explicitRow) {
      vectorLeg.push(explicitRow);
      vectorLeg.sort((a, b) => a.distance - b.distance);
    }
  }

  // ---------------- leg 2: lexical (BM25 over FTS5) ----------------
  // NOTE the query shape: the FTS MATCH + ORDER BY + LIMIT happen in a SUBQUERY, and only then is
  // the result joined to job_postings for filtering. Doing it the obvious way — joining first and
  // filtering in the same statement — makes SQLite load a base-table row for every match, which
  // measured 5,629ms versus 33ms for this shape on the same query. Do not "simplify" it back.
  const lexicalTerms = [
    ...targetRoles,
    ...profileSkills.map(canonicalizeSkill),
    ...domainTerms,
  ];
  const ftsQuery = jobFtsAvailable() ? buildFtsQuery(lexicalTerms) : null;
  let lexicalLeg: Array<{ id: number; rank: number }> = [];
  if (ftsQuery) {
    try {
      lexicalLeg = db.prepare(`
        SELECT f.id, f.rank FROM (
          SELECT rowid AS id, bm25(job_fts, 10.0, 2.0, 1.0) AS rank
          FROM job_fts WHERE job_fts MATCH ?
          ORDER BY rank LIMIT ?
        ) f
        JOIN job_postings j ON j.id = f.id
        WHERE j.embedding IS NOT NULL${rowFilters}
        ORDER BY f.rank
        LIMIT ?
      `).all(ftsQuery, RETRIEVE * 2, RETRIEVE) as Array<{ id: number; rank: number }>;
    } catch (e) {
      // A malformed MATCH expression must degrade to vector-only, not break the dashboard.
      console.warn(`[matches] lexical leg failed, using vector only: ${e instanceof Error ? e.message : String(e)}`);
      lexicalLeg = [];
    }
  }

  if (o.includeJobId && ftsQuery && !lexicalLeg.some((r) => r.id === o.includeJobId)) {
    try {
      const explicitFts = db.prepare(`
        SELECT f.id, f.rank FROM (
          SELECT rowid AS id, bm25(job_fts, 10.0, 2.0, 1.0) AS rank
          FROM job_fts WHERE job_fts MATCH ? AND rowid = ?
        ) f
        JOIN job_postings j ON j.id = f.id
        WHERE j.embedding IS NOT NULL
      `).get(ftsQuery, o.includeJobId) as { id: number; rank: number } | undefined;
      if (explicitFts) {
        lexicalLeg.push(explicitFts);
        lexicalLeg.sort((a, b) => a.rank - b.rank);
      }
    } catch {}
  }

  // ---------------- fuse: Reciprocal Rank Fusion ----------------
  // RRF sums 1/(k + rank) across legs. It compares RANKS, never raw scores, which is the whole
  // point: a 0.78 cosine and a -25.7 BM25 are on unrelated scales and cannot be added.
  const rrf = new Map<number, number>();
  const addLeg = (rows: Array<{ id: number }>) => {
    rows.forEach((r, idx) => {
      rrf.set(r.id, (rrf.get(r.id) || 0) + 1 / (RRF_K + idx + 1));
    });
  };
  addLeg(vectorLeg);
  addLeg(lexicalLeg);
  // Normalise against the BEST OBSERVED fused score, not the theoretical maximum.
  //
  // The theoretical max is "rank 1 in both legs" = 2/(k+1), which essentially no job achieves —
  // a job ranked #1 by vector and #40 by BM25 scored only 0.5 there. Measured: the whole corpus
  // then topped out at 78 with a median of 36 and NOTHING in the "high" tier, which reads as
  // "nothing matches you" and is just as misleading as the old inflation.
  //
  // Retrieval is inherently a *ranking* signal — "how well does this rank among the candidates" —
  // so relative normalisation is the honest treatment of it. The absolute components (skill fit,
  // LLM verdict, context = 45-60% of the weight) are what stop a weak-but-best-available job from
  // scoring high, so this cannot recreate the old "everything is 99%" problem.
  const maxRrf = Math.max(1e-9, ...Array.from(rrf.values()));

  const candidateIds = Array.from(rrf.keys());
  if (candidateIds.length === 0) {
    return { ranked: [], totalEmbedded: 0, hiddenCount: 0 };
  }

  const distanceById = new Map(vectorLeg.map((r) => [r.id, r.distance]));
  const placeholders = candidateIds.map(() => '?').join(',');
  const jobs = db.prepare(`
    SELECT j.id, j.company, j.title, j.location, j.url, j.description, j.domain_priority,
      j.remote_policy, j.visa_sponsorship, j.relocation_offered, j.apply_type, j.source, j.source_platform, j.ingested_at,
      j.last_seen_at, j.posted_at, j.url_status, j.expired_at,
      e.overall_score as eval_overall,
      e.recommendation as eval_recommendation,
      j.hidden_at,
      (SELECT a.status FROM my_applications a WHERE a.job_id = j.id
       ORDER BY a.last_status_change_at DESC LIMIT 1) as application_status
    FROM job_postings j
    LEFT JOIN job_evaluations e ON e.job_id = j.id
    WHERE j.id IN (${placeholders})
      AND (
        j.id = ?
        OR (
          COALESCE(j.apply_type, 'unknown') != 'external'
          AND (
            (j.source NOT IN ('linkedin', 'naukri') AND COALESCE(j.source_platform, '') NOT IN ('linkedin', 'naukri') AND j.url NOT LIKE '%linkedin.com%' AND j.url NOT LIKE '%naukri.com%')
            OR ((j.source = 'linkedin' OR j.source_platform = 'linkedin' OR j.url LIKE '%linkedin.com%') AND j.apply_type = 'easy_apply')
            OR ((j.source = 'naukri' OR j.source_platform = 'naukri' OR j.url LIKE '%naukri.com%') AND j.apply_type = 'direct_apply')
          )
        )
      )
  `).all(...candidateIds, o.includeJobId ?? 0).map((r) => {
    const row = r as Omit<JobRow, 'distance'> & { distance?: number };
    // Rows found only by the lexical leg have no cosine; treat them as "far" rather than 0
    // distance, so a pure keyword hit can't masquerade as a perfect semantic match.
    row.distance = distanceById.has(row.id) ? (distanceById.get(row.id) as number) : 1;
    return row as JobRow;
  }) as JobRow[];

  // --- per-job skill extraction, cached ---
  // Extraction is ~6ms/job and constant per job (descriptions never change after ingest), so it is
  // computed once and reused. Without this the recompute spent ~10s of its ~21s here alone.
  const skillCache = new Map<number, { titleSkills: string[]; bodySkills: string[] }>();
  {
    const ids = jobs.map((j) => j.id);
    const ph = ids.map(() => '?').join(',');
    const cachedRows = db
      .prepare(`SELECT job_id, title_skills, body_skills FROM job_skills WHERE job_id IN (${ph})`)
      .all(...ids) as Array<{ job_id: number; title_skills: string; body_skills: string }>;
    for (const r of cachedRows) {
      try {
        skillCache.set(r.job_id, { titleSkills: JSON.parse(r.title_skills), bodySkills: JSON.parse(r.body_skills) });
      } catch { /* corrupt row — recomputed below */ }
    }
    const missing = jobs.filter((j) => !skillCache.has(j.id));
    if (missing.length) {
      const ins = db.prepare(
        `INSERT INTO job_skills (job_id, title_skills, body_skills) VALUES (?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET title_skills = excluded.title_skills,
           body_skills = excluded.body_skills, computed_at = CURRENT_TIMESTAMP`,
      );
      const fill = db.transaction(() => {
        for (const j of missing) {
          const titleSkills = findSkills(j.title || '');
          const bodySkills = findSkills(j.description || '');
          skillCache.set(j.id, { titleSkills, bodySkills });
          ins.run(j.id, JSON.stringify(titleSkills), JSON.stringify(bodySkills));
        }
      });
      fill();
      console.log(`[matches] extracted skills for ${missing.length} new job(s) (${jobs.length - missing.length} from cache)`);
    }
  }

  const totalEmbedded = (db.prepare(
    `SELECT COUNT(*) as n FROM job_postings WHERE embedding IS NOT NULL${o.includeHidden ? '' : ' AND hidden_at IS NULL'}`
  ).get() as { n: number }).n;

  const hiddenCount = (db.prepare(
    'SELECT COUNT(*) as n FROM job_postings WHERE embedding IS NOT NULL AND hidden_at IS NOT NULL'
  ).get() as { n: number }).n;

  const matches: RankedMatch[] = jobs.map((job) => {
    // NOTE: raw cosine is deliberately NOT computed here any more. It was only ever emitted, never
    // read, and as a standalone number it is misleading — retrieval is now RRF over the vector AND
    // BM25 legs, so `1 - distance` is one input to one leg, not "the match strength".
    const ontologyBoost = getDomainBoost((job.title || '') + ' ' + (job.description || ''), domainTerms);
    const rolePenalty = getRolePenalty(job.title);
    const locationAssessment = getLocationAssessment(
      job.location,
      profileLocation,
      job.remote_policy,
      Boolean(job.visa_sponsorship),
      Boolean(job.relocation_offered),
      job.title,
    );
    // `evalBoost` removed: it was a leftover additive nudge from the v1 model, computed on every
    // row and then discarded. The LLM verdict now enters the score properly — as its own weighted
    // component (25%) plus the "skip" score cap — inside `scoreComposite`.
    const freshnessRef = job.posted_at || job.last_seen_at || job.ingested_at;
    const freshnessBoost = freshnessScore(freshnessRef);
    const legitimacy = classifyLegitimacy({
      ingestedAt: job.last_seen_at || job.ingested_at,
      description: job.description || '',
      title: job.title || '',
      source: job.source,
    });
    const legitimacyPenalty =
      legitimacy.signal === 'suspicious' ? -0.30 :
      legitimacy.signal === 'caution' ? -0.05 :
      0;
    const roleTargetBoost = targetRoleRe && targetRoleRe.test(job.title || '') ? 0.04 : 0;

    const facts = extractPostingFacts(job.description || '', job.location || '', job.title || '', job.url || '');
    const jobText = `${job.title || ''}\n${job.description || ''}`;

    // --- the signal that did not exist before: what the JD needs vs what the résumé has ---
    const fit = analyzeSkillFit({
      jobTitle: job.title || '',
      jobDescription: job.description || '',
      profileSkills,
      cached: skillCache.get(job.id),
      profileSkillSet,
    });

    // --- hard constraints from targets, previously stored and ignored ---
    const dealBreakerHits = termsPresent(jobText, dealBreakers);
    const missingMustHaves = termsAbsent(jobText, mustHaves);
    // Only a STATED salary below the floor counts. An undisclosed salary is not a negative —
    // most postings omit it, and punishing that would bury the whole Indian market.
    const belowCompFloor = hasCompFloor && facts.salaryMax != null && facts.salaryMax < compMin;
    // A target location the user typed (e.g. "Remote", "Bengaluru") appearing in the posting.
    const targetLocationHit = targetLocations.length > 0
      ? termsPresent(`${job.location || ''} ${job.remote_policy || ''}`, targetLocations).length > 0
      : false;

    const ageRef = job.posted_at || job.last_seen_at || job.ingested_at;
    const ageMs = ageRef ? Date.now() - new Date(ageRef).getTime() : NaN;
    const ageDays = Number.isFinite(ageMs) && ageMs >= 0 ? Math.round(ageMs / 86_400_000) : null;

    const retrieval = Math.min(1, (rrf.get(job.id) || 0) / maxRrf);

    const compositeInput = {
      retrieval,
      skillFit: fit,
      llmScore: job.eval_overall,
      llmRecommendation: (job.eval_recommendation as 'apply' | 'consider' | 'skip' | null) || null,
      // A target-location match is worth as much as the built-in India/remote bonus.
      locationScore: locationAssessment.score + (targetLocationHit ? 0.05 : 0),
      freshnessScore: freshnessBoost,
      legitimacyPenalty,
      dealBreakerHits,
      missingMustHaves,
      belowCompFloor,
      domainHit: ontologyBoost > 0,
      roleTargetHit: roleTargetBoost > 0,
      rolePenalty,
    };
    const composite = scoreComposite(compositeInput);

    const reasons = buildReasons({
      fit,
      composite,
      input: compositeInput,
      locationBadge: locationAssessment.badge,
      locationReason: locationAssessment.reason,
      ageDays,
      duplicateCount: 1, // replaced below, once duplicates are collapsed
    });

    // `gapAnalysis` keeps its shape for existing consumers, but both halves are now real:
    // matched/missing come from the skill vocabulary with word-boundary matching instead of
    // substring containment and a stop-worded `\W+` token dump (which produced noise like
    // ["weekday","clientssalary","2500000","yearslocation"]).
    const gapAnalysis = {
      matchedSkills: fit.matched,
      missingKeywords: fit.missing,
    };

    return {
      id: job.id,
      company: job.company,
      title: job.title,
      location: job.location,
      url: job.url,
      source: job.source,
      ingestedAt: job.ingested_at,
      postedAt: job.posted_at || null,
      domainPriority: job.domain_priority,
      remotePolicy: job.remote_policy,
      visaSponsorship: Boolean(job.visa_sponsorship),
      relocationOffered: Boolean(job.relocation_offered),
      applyType: (job.apply_type as RankedMatch['applyType']) || 'unknown',
      sourcePlatform: job.source_platform || (job.url.includes('linkedin.com') ? 'linkedin' : job.url.includes('naukri.com') ? 'naukri' : job.url.includes('indeed.com') ? 'indeed' : null),
      facts,
      locationBadge: locationAssessment.badge,
      locationReason: locationAssessment.reason,
      archetype: classifyArchetype(job.title || ''),
      ontologyBoost,
      rolePenalty,
      // finalScore is now simply score/100, so it stays the 0..1 sort key and every existing
      // `pctClamp(finalScore)` consumer renders the new bounded number unchanged.
      finalScore: composite.score / 100,
      score: composite.score,
      skillFit: fit,
      reasons,
      ageDays,
      // DROPPED from the payload: `scoreParts` (183KB), `retrievalScore` (24KB), `cosineScore`
      // (19KB), `locationScore` (21KB), `evalBoost` (15KB) and `gapCount` (14KB) — 277KB, 14% of
      // the payload, written on every row and rendered by nothing. Each existed only as a field in
      // the TypeScript interface; a repo-wide search finds no component that reads any of them.
      // They were intermediate values of the composite, which now travels as one `score` plus the
      // human-readable `reasons[]` chips that replaced them in the UI. Re-add a specific one only
      // with a consumer in the same change.
      variants: [],
      evaluation: job.eval_recommendation
        ? {
            overall_score: job.eval_overall,
            recommendation: job.eval_recommendation as 'apply' | 'consider' | 'skip',
          }
        : null,
      legitimacy: legitimacy.signal,
      legitimacyReason: legitimacy.reason,
      hidden: !!job.hidden_at,
      applied: !!job.application_status,
      applicationStatus: (job.application_status as RankedMatch['applicationStatus']) || null,
      gapAnalysis,
    };
  });

  matches.sort((a, b) => b.finalScore - a.finalScore);
  return { ranked: diversify(matches).slice(0, POOL), totalEmbedded, hiddenCount };
}

/**
 * Score ONE job against an AI-tailored résumé.
 *
 * The AI-tailored variant is a different document than the profile's active résumé, so its score
 * cannot be read from the shared cache (which is built against `my_profile`). This re-runs the
 * ranking engine with an override profile — same pool, same composite, same hard constraints —
 * so the two numbers are DIRECTLY comparable: "if the tailored résumé were my profile, how well
 * would this job score" next to "what it scores today".
 *
 * What is swapped: the profile's skill set becomes the vocabulary skills that actually appear in
 * the tailored text, and the semantic leg is run against an embedding of that text. Everything
 * else — target roles, must-haves, deal-breakers, comp floor, locations, domain terms — stays the
 * user's own, because tailoring a résumé does not change what they are hunting for.
 *
 * Cost note: this runs the full hybrid-retrieval recompute (same as a cold cache), ~2-7s at this
 * corpus size, plus one embedding of the tailored text (~1-2s). That is why it is a button, not an
 * auto-load. It deliberately does NOT write anything to the persisted cache.
 */
export async function getTailoredMatchScore(
  jobId: number,
  tailoredText: string,
): Promise<{ tailoredMatch: RankedMatch; defaultMatch: RankedMatch | null } | null> {
  const profile = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as { parsed_json: string } | undefined;
  if (!profile) return null;

  const parsedProfile = JSON.parse(profile.parsed_json);
  // The tailored résumé's skill set = the vocabulary skills its text actually contains. These are
  // already canonical, so `buildProfileSkillSet` inside `computeRanked` treats them as authoritative.
  const tailoredSkills = findSkills(tailoredText);
  const embedding = await generateEmbedding(tailoredText);

  const override: ProfileRow = {
    id: 1,
    parsed_json: JSON.stringify({ ...parsedProfile, skills: tailoredSkills }),
    embedding: embeddingToBlob(embedding),
  };

  // Mirror the detail route's pool precedence: the DEFAULT pool first (same options /api/matches
  // uses, so `retrieval` is normalized identically), then fall back to the all-inclusive pool for a
  // hidden / expired / already-applied job opened from /tracker.
  const isApplied = db.prepare('SELECT 1 FROM my_applications WHERE job_id = ? LIMIT 1').get(jobId);
  const pools: RankOpts[] = [
    { includeHidden: false, includeExpired: false, includeApplied: !!isApplied, includeJobId: jobId },
    { includeHidden: true, includeExpired: true, includeApplied: true, includeJobId: jobId },
  ];
  for (const o of pools) {
    const result = computeRanked(o, override);
    const tailoredMatch = result?.ranked.find((m) => m.id === jobId);
    if (tailoredMatch) {
      // The job's CURRENT score, from the shared cache path (which is scored against my_profile).
      let defaultMatch = getRankedMatchById(o, jobId) ?? null;
      if (!defaultMatch) {
        const defPool = computeRanked(o);
        defaultMatch = defPool?.ranked.find((m) => m.id === jobId) ?? null;
      }
      return { tailoredMatch, defaultMatch };
    }
  }
  return null;
}

/**
 * Collapse near-duplicates and stop one company filling the page.
 *
 * Measured on the live corpus: 793 duplicate company+title groups across 7,087 active rows =
 * 1,341 redundant rows (19%), because `dedup_hash` includes `location` — one role advertised in
 * two cities is two rows with byte-identical descriptions. They score identically, so they land
 * adjacent at the top ("solution architect @ Weekday AI" was #1 AND #2).
 *
 * Collapsing happens at READ time, deliberately: changing `dedup_hash` would orphan every
 * existing row's identity and its evaluation/application history.
 *
 * Input must already be sorted best-first — the survivor of each group is the first one seen.
 */
function diversify(sorted: RankedMatch[]): RankedMatch[] {
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const byGroup = new Map<string, RankedMatch>();
  const order: RankedMatch[] = [];

  for (const m of sorted) {
    const key = `${norm(m.company)}|${norm(m.title)}`;
    const existing = byGroup.get(key);
    if (existing) {
      // Same role elsewhere — record the location on the survivor instead of adding a row.
      if (m.location && m.location !== existing.location && !existing.variants.some((v) => v.location === m.location)) {
        existing.variants.push({ id: m.id, location: m.location });
      }
      continue;
    }
    byGroup.set(key, m);
    order.push(m);
  }

  // Re-issue the freshness/duplicate chip now that variant counts are known.
  for (const m of order) {
    if (m.variants.length > 0) {
      m.reasons = [
        ...m.reasons.filter((r) => r.kind !== 'duplicate'),
        { kind: 'duplicate' as const, label: `${m.variants.length + 1} locations`, tone: 'neutral' as const },
      ].slice(0, 5);
    }
  }

  // Per-company cap: keep the best MAX_PER_COMPANY, and append the overflow AFTER everything
  // else rather than dropping it, so nothing becomes unreachable — it just stops crowding the top.
  const perCompany = new Map<string, number>();
  const kept: RankedMatch[] = [];
  const overflow: RankedMatch[] = [];
  for (const m of order) {
    const c = norm(m.company);
    const n = (perCompany.get(c) || 0) + 1;
    perCompany.set(c, n);
    (n <= MAX_PER_COMPANY ? kept : overflow).push(m);
  }
  return [...kept, ...overflow];
}

// Read-through cache. Returns the full ranked list (callers slice for pagination). Recomputes
// only when the signature changed or `refresh` is set. Returns null when there's no profile.
// When each key last STARTED a background recompute. Debouncing is what stops N concurrent
// requests each spawning their own recompute of the same list.
// Hung off globalThis for the SAME reason as `matchMemo` below. As plain module state it was wiped
// on every `next dev` recompile while the memo survived, so the first request after a recompile
// always saw an empty debounce map and spawned another detached recompute process.
const globalForBg = globalThis as unknown as { __hsLastBgStart?: Map<string, number> };
const lastBgStart: Map<string, number> = globalForBg.__hsLastBgStart ?? new Map();
globalForBg.__hsLastBgStart = lastBgStart;
// `computeRanked` is synchronous (better-sqlite3 is), so a "background" recompute still blocks the
// Node event loop for its duration (~2.4s at this corpus size) and any request arriving during it
// waits. That is fine occasionally and bad continuously — and it WOULD be continuous while
// `npm run embed` works a backlog, because the cache signature includes the embedded-job count and
// so changes every batch. Debouncing bounds the damage to one ~2.4s pause per interval instead of
// one per page load. Stale results are at most this old.
const BG_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Spawn the recompute in a SEPARATE PROCESS.
 *
 * `computeRanked` is synchronous, so doing this in-process — even via setImmediate — blocks the
 * event loop for its whole duration (2.4s idle, ~7s while an embed run competes for CPU) and any
 * request arriving in that window stalls. Same reasoning and same mechanism as the detached sync
 * orchestrator in src/lib/sync.ts.
 */
function spawnRecompute(o: RankOpts): void {
  const flags: string[] = [];
  if (o.includeHidden) flags.push('--hidden');
  if (o.includeExpired) flags.push('--expired');
  if (o.includeApplied) flags.push('--applied');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require('child_process') as typeof import('child_process');
    const path = require('path') as typeof import('path');
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js'),
       path.join('scripts', 'recompute-matches.ts'), ...flags],
      { cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore' },
    );
    child.unref();
  } catch (e) {
    console.warn(`[matches] could not spawn recompute: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function shouldStartBackgroundRefresh(key: string): boolean {
  const last = lastBgStart.get(key) ?? 0;
  return Date.now() - last >= BG_REFRESH_MIN_INTERVAL_MS;
}

function persist(key: string, sig: string, result: RankedResult): void {
  db.prepare(
    `INSERT INTO match_cache (cache_key, signature, payload, computed_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(cache_key) DO UPDATE SET
       signature = excluded.signature,
       payload = excluded.payload,
       computed_at = CURRENT_TIMESTAMP`,
  ).run(key, sig, JSON.stringify(result));
}

/**
 * Read-through cache with STALE-WHILE-REVALIDATE.
 *
 * Why: a recompute costs seconds (hybrid retrieval + per-candidate scoring over ~1,600 jobs), and
 * the cache signature includes the embedded-job count — so while `npm run embed` is working through
 * a backlog the signature changes every batch and EVERY page load paid a full recompute. Measured:
 * 20-40 second page loads during an embed run. Blocking a page render on that is indefensible.
 *
 * Now a stale-but-present list is returned IMMEDIATELY and the refresh happens in the background,
 * so a page load is always a cache read (~0.9s at this corpus size). The new list appears on the
 * next load. Only two cases still block:
 *   - `refresh: true` (the user explicitly pressed refresh and is waiting for new results)
 *   - no cached payload at all (first ever load, or after db:reset) — there is nothing to serve
 */
/**
 * Parsed-payload memo.
 *
 * The cached ranked list is ~1.6MB of JSON. Every request that touched it — including
 * `/api/matches/[jobId]`, which fires on EVERY job click and only wants ONE row — read that blob
 * out of SQLite and `JSON.parse`d the whole thing from scratch. Parsing 1.6MB to answer "what is
 * job 15605's score" is the single most wasteful thing in the request path.
 *
 * The memo holds the parsed object plus an id→match index, keyed by `(cacheKey, signature,
 * computed_at)`. Recomputes always rewrite `computed_at`, so a stale memo can never be served: any
 * write invalidates it.
 *
 * The cheap probe matters as much as the memo. On a hit we read only `signature, computed_at` —
 * two small columns — and never touch `payload` at all, so SQLite doesn't materialise the blob
 * either.
 *
 * Hung off `globalThis` for the same reason `db` is (see `globalForDb` in db.ts): `next dev`
 * re-evaluates server modules on demand, which would otherwise discard the memo on every recompile.
 */
type MemoEntry = { signature: string; computedAt: string; result: RankedResult; byId: Map<number, RankedMatch> };
const globalForMatchMemo = globalThis as unknown as { __hsMatchMemo?: Map<string, MemoEntry> };
const matchMemo: Map<string, MemoEntry> = globalForMatchMemo.__hsMatchMemo ?? new Map();
globalForMatchMemo.__hsMatchMemo = matchMemo;

/** Bound the memo — a handful of pools are live at once; anything more is a leak, not a cache. */
const MEMO_MAX_ENTRIES = 8;

function rememberPayload(key: string, signature: string, computedAt: string, result: RankedResult): MemoEntry {
  const byId = new Map<number, RankedMatch>();
  for (const m of result.ranked) byId.set(m.id, m);
  const entry: MemoEntry = { signature, computedAt, result, byId };
  // Delete-then-set so the key moves to the END of the Map's insertion order. `Map.set` on an
  // EXISTING key does not reorder it, which meant the first-inserted (usually hottest) pool was
  // the eviction victim — the opposite of LRU.
  matchMemo.delete(key);
  matchMemo.set(key, entry);
  if (matchMemo.size > MEMO_MAX_ENTRIES) {
    const lru = matchMemo.keys().next().value; // least recently written, given the delete above
    if (lru !== undefined) matchMemo.delete(lru);
  }
  return entry;
}

/**
 * Invalidate or precisely update the match cache (both in-memory memo and SQLite table).
 *
 * When a single job is hidden, unhidden, or applied, calling this function immediately
 * updates the cached pool payloads and signatures in milliseconds so that subsequent
 * /api/matches calls immediately reflect the change without serving a stale result or
 * waiting for a slow background recompute.
 */
export function invalidateMatchCache(
  targetJobId?: number,
  delta?: {
    hidden?: boolean;
    applied?: boolean;
    applicationStatus?: RankedMatch['applicationStatus'];
  }
): void {
  try {
    if (!targetJobId || !delta) {
      // Full invalidation
      matchMemo.clear();
      db.prepare('DELETE FROM match_cache').run();
      return;
    }

    // If restoring an unhidden job or unapplying, a full recompute is needed on next request to bring it back into ranked pool
    if (delta.hidden === false || delta.applied === false) {
      matchMemo.clear();
      db.prepare('DELETE FROM match_cache').run();
      return;
    }

    // 1. Update any entries currently in matchMemo
    for (const [key, entry] of matchMemo.entries()) {
      const o: RankOpts = {
        includeHidden: key[0] === 'h',
        includeExpired: key[1] === 'e',
        includeApplied: key[2] === 'a',
      };

      const m = entry.byId.get(targetJobId);

      if (delta.hidden !== undefined) {
        if (m) {
          m.hidden = delta.hidden;
        }
        if (delta.hidden) {
          entry.result.hiddenCount = (entry.result.hiddenCount || 0) + 1;
          if (!o.includeHidden) {
            entry.result.ranked = entry.result.ranked.filter((r) => r.id !== targetJobId);
          }
        }
      }

      if (delta.applied !== undefined || delta.applicationStatus !== undefined) {
        if (m) {
          if (delta.applied !== undefined) m.applied = delta.applied;
          m.applicationStatus = delta.applicationStatus ?? (delta.applied ? 'applied' : null);
        }
        if (delta.applied && !o.includeApplied) {
          entry.result.ranked = entry.result.ranked.filter((r) => r.id !== targetJobId);
        }
      }

      const newSig = computeSignature(o);
      entry.signature = newSig;
      persist(key, newSig, entry.result);
    }

    // 2. Also update SQLite match_cache rows that may not be loaded in matchMemo
    const cachedRows = db.prepare('SELECT cache_key, payload FROM match_cache').all() as Array<{ cache_key: string; payload: string }>;
    for (const row of cachedRows) {
      if (matchMemo.has(row.cache_key)) continue; // already updated above
      try {
        const parsed = JSON.parse(row.payload) as RankedResult;
        const o: RankOpts = {
          includeHidden: row.cache_key[0] === 'h',
          includeExpired: row.cache_key[1] === 'e',
          includeApplied: row.cache_key[2] === 'a',
        };
        const m = parsed.ranked.find((r) => r.id === targetJobId);
        if (delta.hidden !== undefined) {
          if (m) m.hidden = delta.hidden;
          if (delta.hidden) {
            parsed.hiddenCount = (parsed.hiddenCount || 0) + 1;
            if (!o.includeHidden) {
              parsed.ranked = parsed.ranked.filter((r) => r.id !== targetJobId);
            }
          }
        }
        if (delta.applied !== undefined || delta.applicationStatus !== undefined) {
          if (m) {
            if (delta.applied !== undefined) m.applied = delta.applied;
            m.applicationStatus = delta.applicationStatus ?? (delta.applied ? 'applied' : null);
          }
          if (delta.applied && !o.includeApplied) {
            parsed.ranked = parsed.ranked.filter((r) => r.id !== targetJobId);
          }
        }
        const newSig = computeSignature(o);
        persist(row.cache_key, newSig, parsed);
      } catch {
        db.prepare('DELETE FROM match_cache WHERE cache_key = ?').run(row.cache_key);
      }
    }
  } catch (e) {
    console.warn('[matches] cache invalidation fallback:', e);
    matchMemo.clear();
    try { db.prepare('DELETE FROM match_cache').run(); } catch {}
  }
}

/**
 * Look one job up by id without parsing the payload.
 *
 * `/api/matches/[jobId]` used `ranked.find(...)` — a linear scan over ~1200 rows on top of the full
 * parse. With the memo warm this is a Map hit.
 */
export function getRankedMatchById(o: RankOpts, jobId: number): RankedMatch | undefined {
  const key = cacheKey(o);
  const probe = db
    .prepare('SELECT signature, computed_at FROM match_cache WHERE cache_key = ?')
    .get(key) as { signature: string; computed_at: string } | undefined;
  const memo = matchMemo.get(key);
  if (probe && memo && memo.signature === probe.signature && memo.computedAt === probe.computed_at) {
    // Serve immediately, but if the payload is stale for the CURRENT options, kick off the same
    // background refresh `getRankedMatches` would. Without this a detail request could keep
    // serving a stale score indefinitely (in practice the list route runs alongside and triggers
    // it — but the asymmetry is the bug).
    if (memo.signature !== computeSignature(o) && shouldStartBackgroundRefresh(key)) {
      lastBgStart.set(key, Date.now());
      spawnRecompute(o);
    }
    return memo.byId.get(jobId);
  }
  // Memo cold or invalidated — fall back to the normal path, which repopulates it.
  return getRankedMatches(o)?.ranked.find((m) => m.id === jobId);
}

export function getRankedMatches(o: RankOpts): RankedResult | null {
  const key = cacheKey(o);
  const sig = computeSignature(o);

  if (!o.refresh) {
    // Cheap probe first: two small columns, no 1.6MB blob read. Only on a memo miss do we pay for
    // the payload.
    const probe = db
      .prepare('SELECT signature, computed_at FROM match_cache WHERE cache_key = ?')
      .get(key) as { signature: string; computed_at: string } | undefined;

    const memo = probe ? matchMemo.get(key) : undefined;
    if (memo && memo.signature === probe!.signature && memo.computedAt === probe!.computed_at) {
      if (memo.signature === sig) return memo.result;
      if (shouldStartBackgroundRefresh(key)) {
        lastBgStart.set(key, Date.now());
        spawnRecompute(o);
      }
      return memo.result;
    }

    const row = probe
      ? (db.prepare('SELECT signature, payload, computed_at FROM match_cache WHERE cache_key = ?').get(key) as
          | { signature: string; payload: string; computed_at: string }
          | undefined)
      : undefined;
    if (row?.payload) {
      let cached: RankedResult | null = null;
      try {
        cached = JSON.parse(row.payload) as RankedResult;
        rememberPayload(key, row.signature, row.computed_at, cached);
      } catch { /* corrupt payload — fall through to a blocking recompute */ }

      if (cached) {
        if (row.signature === sig) return cached;

        // Stale. Serve it now; refresh in a separate process (debounced).
        if (shouldStartBackgroundRefresh(key)) {
          lastBgStart.set(key, Date.now());
          spawnRecompute(o);
        }
        return cached;
      }
    }
  }

  // No usable cached payload. A `cachedOnly` caller must not block: warm it in the background and
  // let this request go without.
  if (o.cachedOnly && !o.refresh) {
    if (shouldStartBackgroundRefresh(key)) {
      lastBgStart.set(key, Date.now());
      spawnRecompute(o);
    }
    return null;
  }

  const result = computeRanked(o);
  if (result) {
    persist(key, sig, result);
    // Seed the memo from the object we already hold, so the next request doesn't re-read and
    // re-parse the payload we just wrote. Read computed_at back rather than guessing it — the
    // probe compares against whatever SQLite actually stored.
    const back = db
      .prepare('SELECT computed_at FROM match_cache WHERE cache_key = ?')
      .get(key) as { computed_at: string } | undefined;
    if (back) rememberPayload(key, sig, back.computed_at, result);
  }
  return result;
}
