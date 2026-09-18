// JD keyword extraction for ATS-aware tailoring.
//
// Approach: pattern-match against a curated tech-vocabulary plus extract
// capitalized acronyms / PascalCase technology names appearing in the JD.
// Each candidate is scored by (ontology priority × frequency in JD).
//
// No LLM cost — pure regex + dictionary lookup.

import { ALL_TERMS as ONTOLOGY_TERMS } from './ontology';

// Core tech vocabulary that's not in the healthcare ontology.
// Keep this list curated, not exhaustive — false positives hurt more than misses.
const TECH_VOCAB = [
  // Languages
  'TypeScript', 'JavaScript', 'Python', 'Java', 'Kotlin', 'Go', 'Rust', 'C#', 'Scala',
  'Ruby', 'PHP', 'Swift', 'C++', 'SQL', 'Bash', 'PowerShell',
  // Frontend
  'React', 'Next.js', 'Angular', 'Vue', 'Svelte', 'Redux', 'Tailwind', 'GraphQL',
  // Backend / runtime
  'Node.js', 'Express', 'Spring Boot', 'Spring Framework', 'Django', 'FastAPI', 'Flask',
  '.NET', 'ASP.NET', 'Rails',
  // Data / messaging
  'Postgres', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Cassandra', 'DynamoDB',
  'Elasticsearch', 'Kafka', 'RabbitMQ', 'Snowflake', 'Databricks', 'BigQuery',
  'Spark', 'Airflow', 'dbt', 'Hadoop',
  // Cloud
  'AWS', 'Azure', 'GCP', 'Google Cloud', 'EC2', 'S3', 'Lambda', 'EKS', 'ECS',
  'Azure Functions', 'AKS', 'CloudFormation', 'Terraform', 'Pulumi',
  // Containers / infra
  'Docker', 'Kubernetes', 'Helm', 'Istio', 'Envoy', 'Nginx', 'Linkerd',
  // CI / DevOps / observability
  'CI/CD', 'GitHub Actions', 'Jenkins', 'CircleCI', 'GitLab CI', 'ArgoCD', 'FluxCD',
  'Prometheus', 'Grafana', 'Datadog', 'New Relic', 'Splunk', 'OpenTelemetry',
  'PagerDuty', 'ELK', 'Loki',
  // Architecture / patterns
  'microservices', 'event-driven', 'event sourcing', 'CQRS', 'serverless',
  'monolith', 'service mesh', 'REST', 'gRPC', 'OAuth', 'SAML', 'OIDC', 'JWT',
  'SSO', 'WebSocket', 'webhook', 'API Gateway',
  // ML / AI
  'PyTorch', 'TensorFlow', 'scikit-learn', 'Hugging Face', 'LLM', 'RAG',
  'embeddings', 'vector database', 'fine-tuning',
  // Methodology
  'Agile', 'Scrum', 'Kanban', 'SDLC', 'TDD', 'BDD', 'pair programming',
  // Security / compliance buckets non-healthcare
  'SOC 2', 'ISO 27001', 'GDPR', 'PCI DSS', 'penetration testing', 'OWASP',
  // Testing
  'Jest', 'Cypress', 'Playwright', 'Selenium', 'JUnit', 'Mockito', 'pytest',
];

// Combined master vocabulary; ontology terms are scored higher (they're domain-specific).
function buildVocab(): Array<{ term: string; weight: number }> {
  const out: Array<{ term: string; weight: number }> = [];
  for (const t of ONTOLOGY_TERMS) out.push({ term: t, weight: 2.0 }); // healthcare-IT primary
  for (const t of TECH_VOCAB) out.push({ term: t, weight: 1.0 });
  return out;
}

const VOCAB = buildVocab();

// Acronyms (3-5 caps) and PascalCase tech-looking names found in the JD itself —
// catches one-offs that aren't in our vocab (e.g. "Wellpoint", "Stripe", "Splunk" if missed).
const ACRONYM_RE = /\b[A-Z]{2,5}\b/g;
const PASCAL_RE = /\b(?:[A-Z][a-z]+){2,}\b/g; // e.g. "MirthConnect", "OracleHealth"

// Stop list to filter false-positive acronyms (English filler, not technical).
const ACRONYM_STOP = new Set([
  'AND', 'OR', 'NOT', 'BUT', 'FOR', 'YOU', 'OUR', 'WE', 'US', 'IT',
  'THE', 'WHO', 'WHAT', 'WHY', 'HOW', 'WHEN', 'WHERE', 'CAN', 'WILL',
  'MAY', 'MUST', 'SHOULD', 'COULD', 'WOULD', 'SHALL', 'EACH', 'EVERY',
  'INC', 'LLC', 'LTD', 'CORP', 'CO', 'GMBH',
  'ETC', 'IE', 'EG', 'EX', 'NA', 'NB', 'PS', 'PPS', 'TLDR',
  // Common section labels in JDs
  'JOB', 'ROLE', 'TEAM', 'WORK', 'PLUS', 'MUST', 'NICE',
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Count occurrences of a term in text (case-insensitive, word-boundary on alphanumeric edges).
function countOccurrences(text: string, term: string): number {
  // Build a regex with word boundaries that work for terms containing punctuation (e.g. "Node.js", ".NET")
  const escaped = escapeRegExp(term);
  // For terms with a leading/trailing letter, anchor with \b. For symbol-edge terms like ".NET",
  // anchor with whitespace-or-edge instead.
  const startsAlnum = /^[A-Za-z0-9]/.test(term);
  const endsAlnum = /[A-Za-z0-9]$/.test(term[term.length - 1]);
  const left = startsAlnum ? '(?:^|[^A-Za-z0-9])' : '';
  const right = endsAlnum ? '(?:$|[^A-Za-z0-9])' : '';
  const re = new RegExp(`${left}${escaped}${right}`, 'gi');
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

export interface JdKeyword {
  term: string;     // canonical form (matches the vocab spelling, or first-seen casing for acronyms)
  weight: number;   // ontology=2, tech=1, found-acronym=0.7
  hits: number;     // number of occurrences in the JD
  score: number;    // weight * log(1 + hits)
}

/**
 * Extract the top N keywords from a JD that an ATS-tailored resume should mirror.
 * Returns highest-scoring first.
 */
export function extractJdKeywords(jdText: string, jobTitle = '', max = 15): JdKeyword[] {
  const haystack = `${jobTitle}\n${jdText || ''}`;
  if (haystack.trim().length < 50) return [];

  const candidates = new Map<string, JdKeyword>();

  // 1. Vocabulary hits — ontology + tech
  for (const { term, weight } of VOCAB) {
    const hits = countOccurrences(haystack, term);
    if (hits > 0) {
      const score = weight * Math.log1p(hits);
      const key = term.toLowerCase();
      // Keep the highest-scoring instance (prefer ontology over tech if both match)
      const prev = candidates.get(key);
      if (!prev || score > prev.score) {
        candidates.set(key, { term, weight, hits, score });
      }
    }
  }

  // 2. Acronyms found in the JD that aren't already captured (catches Wellpoint-style one-offs)
  const acronymHits = new Map<string, number>();
  for (const m of haystack.match(ACRONYM_RE) || []) {
    if (ACRONYM_STOP.has(m)) continue;
    if (m.length < 2) continue;
    acronymHits.set(m, (acronymHits.get(m) || 0) + 1);
  }
  acronymHits.forEach((hits, acr) => {
    if (hits < 2) return; // require ≥2 occurrences to filter random caps
    const key = acr.toLowerCase();
    if (candidates.has(key)) return;
    candidates.set(key, { term: acr, weight: 0.7, hits, score: 0.7 * Math.log1p(hits) });
  });

  // 3. PascalCase technical names (e.g. "MirthConnect", "EpicAppOrchard")
  const pascalHits = new Map<string, number>();
  for (const m of haystack.match(PASCAL_RE) || []) {
    if (m.length < 6) continue; // skip noise like "TheJob"
    pascalHits.set(m, (pascalHits.get(m) || 0) + 1);
  }
  pascalHits.forEach((hits, pn) => {
    if (hits < 2) return;
    const key = pn.toLowerCase();
    if (candidates.has(key)) return;
    candidates.set(key, { term: pn, weight: 0.6, hits, score: 0.6 * Math.log1p(hits) });
  });

  // Sort descending and slice
  return Array.from(candidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

/**
 * Count which of `keywords` actually appear in `text` (case-insensitive, word-boundary).
 * Used post-generation to give the user a "JD match: 12/15" signal.
 */
export function matchKeywordsInText(text: string, keywords: JdKeyword[]): { matched: string[]; missing: string[] } {
  const matched: string[] = [];
  const missing: string[] = [];
  for (const k of keywords) {
    if (countOccurrences(text, k.term) > 0) matched.push(k.term);
    else missing.push(k.term);
  }
  return { matched, missing };
}
