// skills-vocab.ts — a canonical technical-skill vocabulary and a precise text matcher.
//
// WHY THIS EXISTS: ranking used to compare the résumé and the JD only as whole-document embedding
// cosine, which cannot tell "Solution Architect (FHIR/Azure)" from "Solution Architect (Java/Spring)"
// — both are topically near-identical to a senior-architect résumé. Measured before this existed:
// `Java Solution Architect - Spring Boot` scored 98% for a candidate with no Java anywhere in 74
// listed skills. To penalise that we must be able to name the skills a JD REQUIRES, including the
// ones the candidate does not have — which needs a vocabulary independent of the résumé.
//
// The ontology in `ontology.ts` covers the healthcare domain only, and `domain_terms` follows the
// résumé, so neither can ever surface a missing skill. This file is the complement.
//
// MATCHING RULES (the subtle part — naive `includes()` is what made the old gap analysis useless):
//   - Word boundaries, so `Java` does NOT match `JavaScript`, and `R` does not match every word
//     containing an r. This single distinction is the whole point of the file.
//   - Symbol-bearing names (`C++`, `C#`, `.NET`, `Node.js`) cannot use \b — \b is defined between
//     \w and non-\w, and `+`/`#`/`.` are non-\w — so those use explicit lookarounds instead.
//   - Aliases are matched but always reported under the canonical name, so `k8s` and `Kubernetes`
//     don't count as two different skills.

export interface SkillDef {
  canonical: string;
  aliases?: string[];
  /** Coarse grouping, used to explain a mismatch ("different language/runtime"). */
  group: 'language' | 'runtime' | 'frontend' | 'backend' | 'data' | 'cloud' | 'devops' | 'healthcare' | 'practice';
}

export const TECH_SKILLS: SkillDef[] = [
  // --- languages: the group that most often makes a role wrong for a candidate ---
  { canonical: 'Java', aliases: ['java se', 'java ee', 'j2ee', 'core java'], group: 'language' },
  { canonical: 'Kotlin', group: 'language' },
  { canonical: 'Scala', group: 'language' },
  { canonical: 'Groovy', group: 'language' },
  { canonical: 'C#', aliases: ['c sharp', 'csharp'], group: 'language' },
  { canonical: '.NET', aliases: ['dotnet', 'dot net', 'asp.net', 'aspnet', '.net core'], group: 'language' },
  { canonical: 'VB.NET', aliases: ['visual basic'], group: 'language' },
  { canonical: 'C++', aliases: ['cpp'], group: 'language' },
  // NOTE: bare `C` and bare `R` are deliberately NOT in this vocabulary. A single-letter token
  // matches far too much even with word boundaries — `c` matches the "C" in "C-CDA" (caught
  // in testing: a FHIR architect role reported "C ✓"), and `r` matches "R&D", "R1", list
  // bullets. The false-positive cost outweighs the signal; detecting them properly would need
  // contextual matching ("C developer", "R programming") which is not worth it here.
  { canonical: 'Go', aliases: ['golang'], group: 'language' },
  { canonical: 'Rust', group: 'language' },
  { canonical: 'Python', group: 'language' },
  { canonical: 'Ruby', aliases: ['ruby on rails', 'rails'], group: 'language' },
  { canonical: 'PHP', aliases: ['laravel', 'symfony'], group: 'language' },
  { canonical: 'Perl', group: 'language' },
  { canonical: 'Swift', group: 'language' },
  { canonical: 'Objective-C', group: 'language' },
  { canonical: 'Dart', aliases: ['flutter'], group: 'language' },
  { canonical: 'Elixir', aliases: ['erlang', 'phoenix framework'], group: 'language' },
  { canonical: 'Haskell', group: 'language' },
  { canonical: 'Clojure', group: 'language' },
  { canonical: 'MATLAB', group: 'language' },
  { canonical: 'COBOL', group: 'language' },
  { canonical: 'ABAP', group: 'language' },
  { canonical: 'JavaScript', aliases: ['js', 'es6', 'ecmascript'], group: 'language' },
  { canonical: 'TypeScript', aliases: ['ts'], group: 'language' },

  // --- runtimes / frameworks ---
  { canonical: 'Spring Boot', aliases: ['spring', 'spring framework', 'spring cloud', 'spring mvc'], group: 'runtime' },
  { canonical: 'Hibernate', aliases: ['jpa'], group: 'runtime' },
  { canonical: 'Micronaut', group: 'runtime' },
  { canonical: 'Quarkus', group: 'runtime' },
  { canonical: 'Node.js', aliases: ['node', 'nodejs'], group: 'runtime' },
  { canonical: 'Express', aliases: ['express.js', 'expressjs'], group: 'runtime' },
  { canonical: 'NestJS', aliases: ['nest.js'], group: 'runtime' },
  { canonical: 'Django', group: 'runtime' },
  { canonical: 'Flask', group: 'runtime' },
  { canonical: 'FastAPI', group: 'runtime' },
  { canonical: 'Deno', group: 'runtime' },

  // --- frontend ---
  { canonical: 'React', aliases: ['react.js', 'reactjs'], group: 'frontend' },
  { canonical: 'React Native', group: 'frontend' },
  { canonical: 'Next.js', aliases: ['nextjs'], group: 'frontend' },
  { canonical: 'Angular', aliases: ['angularjs'], group: 'frontend' },
  { canonical: 'Vue', aliases: ['vue.js', 'vuejs', 'nuxt'], group: 'frontend' },
  { canonical: 'Svelte', aliases: ['sveltekit'], group: 'frontend' },
  { canonical: 'Tailwind CSS', aliases: ['tailwind'], group: 'frontend' },
  { canonical: 'HTML', aliases: ['html5'], group: 'frontend' },
  { canonical: 'CSS', aliases: ['css3', 'sass', 'scss'], group: 'frontend' },

  // --- backend / architecture practice ---
  { canonical: 'Microservices', aliases: ['micro-services', 'microservice'], group: 'backend' },
  { canonical: 'REST APIs', aliases: ['rest', 'restful', 'restful apis', 'rest api'], group: 'backend' },
  { canonical: 'GraphQL', group: 'backend' },
  { canonical: 'gRPC', group: 'backend' },
  { canonical: 'SOAP', group: 'backend' },
  { canonical: 'Event-Driven Architecture', aliases: ['event driven', 'event sourcing', 'cqrs'], group: 'backend' },
  { canonical: 'Kafka', aliases: ['apache kafka', 'confluent'], group: 'backend' },
  { canonical: 'RabbitMQ', group: 'backend' },
  { canonical: 'Azure Service Bus', group: 'backend' },
  { canonical: 'Redis', group: 'backend' },
  { canonical: 'Elasticsearch', aliases: ['opensearch', 'elk'], group: 'backend' },
  { canonical: 'API Gateway', aliases: ['apim', 'api management'], group: 'backend' },
  { canonical: 'OAuth', aliases: ['oauth2', 'oidc', 'openid connect'], group: 'backend' },
  { canonical: 'SAML', group: 'backend' },
  { canonical: 'JWT', group: 'backend' },

  // --- data ---
  { canonical: 'SQL', group: 'data' },
  { canonical: 'SQL Server', aliases: ['mssql', 'microsoft sql server', 't-sql', 'tsql'], group: 'data' },
  { canonical: 'PostgreSQL', aliases: ['postgres'], group: 'data' },
  { canonical: 'MySQL', aliases: ['mariadb'], group: 'data' },
  { canonical: 'Oracle Database', aliases: ['oracle db', 'pl/sql', 'plsql'], group: 'data' },
  { canonical: 'MongoDB', aliases: ['mongo'], group: 'data' },
  { canonical: 'Cosmos DB', aliases: ['cosmosdb'], group: 'data' },
  { canonical: 'DynamoDB', group: 'data' },
  { canonical: 'Cassandra', group: 'data' },
  { canonical: 'Snowflake', group: 'data' },
  { canonical: 'Databricks', group: 'data' },
  { canonical: 'Spark', aliases: ['apache spark', 'pyspark'], group: 'data' },
  { canonical: 'Hadoop', aliases: ['hive', 'hdfs'], group: 'data' },
  { canonical: 'Airflow', aliases: ['apache airflow'], group: 'data' },
  { canonical: 'dbt', group: 'data' },
  { canonical: 'ETL', aliases: ['elt', 'data pipeline', 'data pipelines'], group: 'data' },
  { canonical: 'Azure Data Factory', aliases: ['adf'], group: 'data' },
  { canonical: 'Power BI', aliases: ['powerbi'], group: 'data' },
  { canonical: 'Tableau', group: 'data' },

  // --- cloud ---
  { canonical: 'Azure', aliases: ['microsoft azure'], group: 'cloud' },
  { canonical: 'AWS', aliases: ['amazon web services'], group: 'cloud' },
  { canonical: 'GCP', aliases: ['google cloud', 'google cloud platform'], group: 'cloud' },
  { canonical: 'Azure Functions', group: 'cloud' },
  { canonical: 'AWS Lambda', aliases: ['lambda'], group: 'cloud' },
  { canonical: 'Serverless', group: 'cloud' },
  { canonical: 'Azure DevOps', aliases: ['vsts', 'tfs'], group: 'cloud' },
  { canonical: 'Azure Kubernetes Service', aliases: ['aks'], group: 'cloud' },
  { canonical: 'EKS', group: 'cloud' },

  // --- devops ---
  { canonical: 'Docker', aliases: ['containers', 'containerization'], group: 'devops' },
  { canonical: 'Kubernetes', aliases: ['k8s'], group: 'devops' },
  { canonical: 'Helm', group: 'devops' },
  { canonical: 'Terraform', group: 'devops' },
  { canonical: 'Bicep', group: 'devops' },
  { canonical: 'Ansible', group: 'devops' },
  { canonical: 'CI/CD', aliases: ['ci cd', 'continuous integration', 'continuous delivery'], group: 'devops' },
  { canonical: 'Jenkins', group: 'devops' },
  { canonical: 'GitHub Actions', group: 'devops' },
  { canonical: 'GitLab CI', aliases: ['gitlab ci/cd'], group: 'devops' },
  { canonical: 'Prometheus', aliases: ['grafana'], group: 'devops' },
  { canonical: 'Datadog', group: 'devops' },
  { canonical: 'Splunk', group: 'devops' },
  { canonical: 'Linux', aliases: ['unix'], group: 'devops' },
  { canonical: 'Git', group: 'devops' },

  // --- healthcare interoperability (complements ontology.ts; kept here so one matcher covers all) ---
  { canonical: 'HL7 FHIR', aliases: ['fhir', 'fhir r4', 'fhir stu3', 'smart on fhir'], group: 'healthcare' },
  { canonical: 'HL7 v2', aliases: ['hl7v2', 'hl7 2.x'], group: 'healthcare' },
  { canonical: 'HL7', group: 'healthcare' },
  { canonical: 'C-CDA', aliases: ['ccda', 'cda'], group: 'healthcare' },
  { canonical: 'USCDI', group: 'healthcare' },
  { canonical: 'X12 EDI', aliases: ['edi x12', 'x12', 'edi'], group: 'healthcare' },
  { canonical: 'EMPI', aliases: ['mpi', 'patient matching'], group: 'healthcare' },
  { canonical: 'Epic', aliases: ['epic ehr', 'epic bridges'], group: 'healthcare' },
  { canonical: 'Cerner', aliases: ['oracle health', 'cerner millennium'], group: 'healthcare' },
  { canonical: 'Mirth Connect', aliases: ['mirth', 'nextgen connect'], group: 'healthcare' },
  { canonical: 'HIPAA', group: 'healthcare' },
  { canonical: 'Azure Health Data Services', aliases: ['azure api for fhir', 'azure fhir'], group: 'healthcare' },
  { canonical: 'AWS HealthLake', aliases: ['healthlake'], group: 'healthcare' },
  { canonical: 'SNOMED', aliases: ['snomed ct'], group: 'healthcare' },
  { canonical: 'LOINC', group: 'healthcare' },
  { canonical: 'ICD-10', aliases: ['icd10'], group: 'healthcare' },
  { canonical: 'RxNorm', group: 'healthcare' },
  { canonical: 'DICOM', group: 'healthcare' },
  { canonical: 'Interoperability', group: 'healthcare' },
  { canonical: 'Prior Authorization', aliases: ['prior auth'], group: 'healthcare' },
  { canonical: 'CMS Interoperability', aliases: ['cms-0057', 'cms 0057', 'cms-9115'], group: 'healthcare' },

  // --- AI / practice ---
  { canonical: 'Generative AI', aliases: ['genai', 'gen ai', 'llm', 'llms', 'large language model'], group: 'practice' },
  { canonical: 'RAG', aliases: ['retrieval augmented generation'], group: 'practice' },
  { canonical: 'Prompt Engineering', group: 'practice' },
  { canonical: 'Machine Learning', aliases: ['ml'], group: 'practice' },
  { canonical: 'MLOps', group: 'practice' },
  { canonical: 'TensorFlow', group: 'practice' },
  { canonical: 'PyTorch', group: 'practice' },
  { canonical: 'Solution Architecture', aliases: ['solution design', 'solutions architecture'], group: 'practice' },
  { canonical: 'Enterprise Architecture', aliases: ['togaf'], group: 'practice' },
  { canonical: 'Agile', aliases: ['scrum', 'kanban', 'safe agile'], group: 'practice' },
  { canonical: 'System Design', aliases: ['scalable system design'], group: 'practice' },
  { canonical: 'Test Automation', aliases: ['selenium', 'cypress', 'playwright', 'robot framework'], group: 'practice' },
];

/** Names that are dangerous as substrings and must always match with strict boundaries. */
const SYMBOLIC = /[+#./]/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One regex per skill, matching the canonical name plus every alias.
 *
 * `\b` is unusable for names containing `+ # . /` because \b sits between \w and non-\w, so
 * `\bc\+\+\b` never matches "c++ " — those get explicit character-class lookarounds instead.
 * For plain alphanumeric names \b is exactly right, and it is what stops `Java` matching
 * `JavaScript` (there is no boundary between "java" and "script").
 */
function buildPattern(def: SkillDef): RegExp {
  const forms = [def.canonical, ...(def.aliases || [])].map((f) => f.toLowerCase());
  const parts = forms.map((form) => {
    const body = escapeRe(form);
    if (SYMBOLIC.test(form)) {
      // Don't let `.NET` match `asp.net` mid-token, and don't let `C++` match `C++11`... but do
      // allow a trailing digit/space, so `(?![a-z0-9])` rather than a full boundary.
      return `(?<![a-z0-9+#./])${body}(?![a-z0-9+#])`;
    }
    return `\\b${body}\\b`;
  });
  return new RegExp(`(?:${parts.join('|')})`, 'i');
}

let compiled: Array<{ def: SkillDef; re: RegExp }> | null = null;
function matchers(): Array<{ def: SkillDef; re: RegExp }> {
  if (!compiled) compiled = TECH_SKILLS.map((def) => ({ def, re: buildPattern(def) }));
  return compiled;
}

/** Canonical skills mentioned anywhere in `text`. */
export function findSkills(text: string): string[] {
  if (!text) return [];
  const hay = text.toLowerCase();
  const out: string[] = [];
  for (const { def, re } of matchers()) {
    if (re.test(hay)) out.push(def.canonical);
  }
  return out;
}

/** Is one specific canonical skill present in `text`? Falls back to a boundary match for
 *  skills outside the vocabulary (e.g. free-text résumé skills we don't have a def for). */
export function hasSkill(text: string, skill: string): boolean {
  if (!text || !skill) return false;
  const known = matchers().find((m) => m.def.canonical.toLowerCase() === skill.trim().toLowerCase());
  if (known) return known.re.test(text.toLowerCase());
  const s = skill.trim().toLowerCase();
  if (!s) return false;
  const body = escapeRe(s);
  const re = SYMBOLIC.test(s)
    ? new RegExp(`(?<![a-z0-9+#./])${body}(?![a-z0-9+#])`, 'i')
    : new RegExp(`\\b${body}\\b`, 'i');
  return re.test(text.toLowerCase());
}

/** The group a canonical skill belongs to — used to phrase a mismatch reason. */
export function skillGroup(skill: string): SkillDef['group'] | null {
  const def = TECH_SKILLS.find((d) => d.canonical.toLowerCase() === skill.trim().toLowerCase());
  return def ? def.group : null;
}

/** Canonicalise a free-text skill (from a résumé) onto the vocabulary where possible, so
 *  "k8s" from a JD and "Kubernetes" from a résumé are recognised as the same thing. */
export function canonicalizeSkill(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return raw.trim();
  for (const def of TECH_SKILLS) {
    if (def.canonical.toLowerCase() === s) return def.canonical;
    if ((def.aliases || []).some((a) => a.toLowerCase() === s)) return def.canonical;
  }
  return raw.trim();
}
