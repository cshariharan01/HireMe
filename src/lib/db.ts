import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
// Load sqlite-vec extension
import * as sqliteVec from 'sqlite-vec';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Database file. `HIRESIGNAL_DB` overrides it.
 *
 * THE OVERRIDE IS A SAFETY FEATURE, and it was missing here. `scripts/prune-stale.ts` honours
 * `HIRESIGNAL_DB` because it opens its own handle, and CLAUDE.md tells you to test destructive
 * changes against a copy with it — but ANY script importing this module silently ignored it and
 * wrote to the real database instead. A "dry run against a copy" of a data-repair script therefore
 * modified production while reporting success against the copy. Honouring it here makes that
 * instruction true for every script.
 */
const DB_PATH = process.env.HIRESIGNAL_DB
  ? path.resolve(process.env.HIRESIGNAL_DB)
  : path.join(DATA_DIR, 'hiresignal.db');

// Reuse a single connection across Next dev recompiles. Without this guard, every server-module
// re-evaluation opens a fresh handle and re-runs the whole schema init (CREATE TABLE ×many, the
// resumes seed, and 35 ALTER TABLEs) — wasteful and a source of dev latency. In production the
// module is evaluated once, so the guard is a no-op there.
const globalForDb = globalThis as unknown as { __hiresignalDb?: Database.Database };

function initDb(): Database.Database {
  const db = new Database(DB_PATH);
  sqliteVec.load(db);

  // WAL + tuning. synchronous=NORMAL is the recommended companion to WAL — it drops the
  // per-commit fsync (durable across app crashes, only at risk on OS/power loss) which matters
  // because the app writes on many hot paths (caches, sync heartbeat). The rest are cheap wins.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 134217728');  // 128 MB memory-mapped I/O
  db.pragma('cache_size = -16000');    // ~16 MB page cache

  // Create tables
  db.exec(`
  CREATE TABLE IF NOT EXISTS job_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    company TEXT,
    title TEXT,
    location TEXT,
    description TEXT,
    url TEXT,
    embedding BLOB,
    domain_priority INTEGER DEFAULT 0,
    remote_policy TEXT,
    visa_sponsorship INTEGER DEFAULT 0,
    relocation_offered INTEGER DEFAULT 0,
    dedup_hash TEXT UNIQUE,
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS my_profile (
    id INTEGER PRIMARY KEY DEFAULT 1,
    raw_text TEXT,
    parsed_json TEXT,
    embedding BLOB,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS my_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER REFERENCES job_postings(id),
    status TEXT CHECK(status IN ('applied','screening','interview','offer','rejected')),
    cover_letter TEXT,
    resume_variant TEXT,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS job_evaluations (
    job_id INTEGER PRIMARY KEY REFERENCES job_postings(id),
    provider TEXT,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    overall_score REAL,
    recommendation TEXT,
    cv_alignment_score REAL,
    cv_alignment_notes TEXT,
    north_star_fit_score REAL,
    north_star_fit_notes TEXT,
    compensation_score REAL,
    compensation_notes TEXT,
    culture_score REAL,
    culture_notes TEXT,
    strategy_notes TEXT
  );

  -- Multi-provider LLM config. One row per configured provider; only one is_active=1 at a time.
  -- When no row is_active, the runtime falls back to env-based selection (preserves prior behavior).
  CREATE TABLE IF NOT EXISTS llm_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('gemini','openai','anthropic','openai-compatible','ollama','freeway')),
    display_name TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key TEXT,
    base_url TEXT,
    is_active INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Ambitionbox per-company cache. Lazy on-view (same pattern as Levels.fyi).
  -- One row per company_slug. Stores top-line ratings as flat columns for fast
  -- queries; full salaries + review samples in JSON for the UI panel.
  CREATE TABLE IF NOT EXISTS ambitionbox_data (
    company_slug TEXT PRIMARY KEY,
    ambitionbox_slug TEXT,
    company_name TEXT,
    hq TEXT,
    industry TEXT,
    employee_band TEXT,
    followers_count INTEGER,
    overall_rating REAL,
    industry_rating REAL,
    total_reviews INTEGER,
    work_life REAL,
    company_culture REAL,
    compensation_benefits REAL,
    career_growth REAL,
    job_security REAL,
    work_satisfaction REAL,
    skill_development REAL,
    last_updated_at TEXT,
    salaries_json TEXT,
    reviews_json TEXT,
    source_url TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Layoff events scraped from Layoffs.fyi (Airtable embed). One row per event.
  -- Bulk-refreshed by the ingest:layoffs script. Per-company lookup is a SQL query.
  -- The composite uniqueness constraint dedups when the same event is re-scraped.
  CREATE TABLE IF NOT EXISTS layoffs_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,                 -- raw company name as it appears on Layoffs.fyi
    company_slug TEXT NOT NULL,            -- normalized lowercase key (matches company_briefs)
    laid_off_count INTEGER,                -- # Laid Off — null if undisclosed
    laid_off_pct REAL,                     -- 0..1 fraction; null if undisclosed
    layoff_date TEXT,                      -- ISO date string of the event
    industry TEXT,
    country TEXT,
    location_hq TEXT,                      -- comma-separated list of HQ locations
    stage TEXT,                            -- e.g. Series B, Post-IPO, Acquired, Unknown
    funds_raised_mm REAL,                  -- $ Raised in millions, null if undisclosed
    source_url TEXT,                       -- citation link from Layoffs.fyi
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_slug, layoff_date, laid_off_count)
  );
  CREATE INDEX IF NOT EXISTS layoffs_company_idx ON layoffs_data(company_slug);

  -- Compensation data scraped from Levels.fyi per company. Cached lazily on first
  -- view — refreshed only on explicit ?refresh=1. Stored as JSON for the full
  -- breakdown (multiple roles + levels), plus flat top-line fields for fast queries.
  CREATE TABLE IF NOT EXISTS compensation_data (
    company_slug TEXT NOT NULL,            -- normalized company key (matches company_briefs)
    region TEXT NOT NULL,                  -- 'US' | 'IN' (for Levels.fyi country=43)
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Top-line summary
    median_total_usd INTEGER,              -- median across all roles, in USD
    currency TEXT,                         -- raw currency from Levels page (e.g. 'USD', 'INR')
    sample_count INTEGER,                  -- number of comp records observed
    source_url TEXT,                       -- canonical Levels.fyi URL
    -- Full breakdown payload — parsed overview array from the page data
    -- Each row: name, slug, breakdown of level totals + counts, optional titles
    breakdown_json TEXT,
    PRIMARY KEY (company_slug, region)
  );

  -- Company brief: per-company research cached and reused across all roles at that company.
  -- Modeled after Sawan Kapoor's recession-resilience-first lens for application decisions.
  CREATE TABLE IF NOT EXISTS company_briefs (
    company_slug TEXT PRIMARY KEY,         -- normalized lowercase company key
    display_name TEXT,
    provider TEXT,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Financial resilience (the core Sawan lens)
    financial_health_score REAL,           -- 1-5
    financial_health_summary TEXT,
    funding_summary TEXT,                  -- "Series B, $35M raised, last round 2024"
    layoffs_summary TEXT,                  -- "No layoffs in 24 months" or "Cut 8% in Mar 2024"
    growth_signal TEXT,                    -- "+25% headcount YoY" or "Slowing"
    -- Culture
    culture_score REAL,                    -- 1-5
    culture_summary TEXT,
    positive_themes TEXT,                  -- JSON array of strings
    concerns TEXT,                         -- JSON array of strings
    retention_signal TEXT,                 -- "Median tenure ~3 yr" or "High turnover"
    -- Compensation
    comp_summary TEXT,                     -- "P50 $165k for SE in US Remote (Levels.fyi)"
    -- Legitimacy / decision
    legitimacy_score REAL,                 -- 1-5: real company? real role?
    legitimacy_notes TEXT,
    overall_score REAL,                    -- 1-5 weighted average
    recommendation TEXT,                   -- 'apply' | 'hold' | 'pass'
    questions_for_recruiter TEXT,          -- JSON array of strings
    evidence_sources TEXT                  -- JSON array of {label, url}
  );

  -- Auto-apply: reusable Q&A library across applications.
  -- When a portal asks "Are you authorized to work in the US?", we hash the question
  -- text, look up an existing answer, and reuse it. New questions fall back to LLM,
  -- get saved here for next time. Categories help bulk-edit (e.g. "all work-auth Qs").
  CREATE TABLE IF NOT EXISTS screening_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_hash TEXT NOT NULL UNIQUE,    -- sha256 of normalized question text
    question TEXT NOT NULL,                -- raw question text as the portal asked it
    answer TEXT NOT NULL,                  -- the answer we used / will reuse
    category TEXT,                         -- 'work_auth' | 'sponsorship' | 'comp' | 'notice' | 'why_company' | 'eeo' | 'other'
    used_count INTEGER DEFAULT 1,
    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Auto-apply: every submission attempt logged, success or fail.
  -- payload_snapshot is the exact JSON we POSTed (or planned to POST in dry-run).
  -- Used for: rate-limit counting, post-mortem on rejections, audit trail.
  CREATE TABLE IF NOT EXISTS apply_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER REFERENCES job_postings(id),
    attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    strategy TEXT NOT NULL,                -- 'greenhouse' | 'ashby' | 'lever' | 'browser' | 'linkedin'
    status TEXT NOT NULL,                  -- 'success' | 'error' | 'dry_run' | 'rate_limited'
    error TEXT,                            -- null on success
    submission_id TEXT,                    -- portal-returned ID if any
    payload_snapshot TEXT                  -- JSON of the request we sent
  );
  CREATE INDEX IF NOT EXISTS apply_audit_attempted_idx ON apply_audit(attempted_at);
  CREATE INDEX IF NOT EXISTS apply_audit_strategy_idx ON apply_audit(strategy);

  -- Auto-apply: settings (key-value store for per-portal toggles + defaults).
  -- Single-row table keyed by 'singleton'; convenient JSON blob beats 20 ALTER columns.
  CREATE TABLE IF NOT EXISTS apply_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Employer-specific application "recipes" — the app's memory of each external ATS process.
  -- Keyed by the employer's site host. Learns which reveal labels produced a step, whether the
  -- flow needs a manual sign-in / CAPTCHA, and the outcome, so the next apply to the same
  -- employer starts from the learned labels and skips re-probing. See src/lib/apply/recipes.ts.
  CREATE TABLE IF NOT EXISTS apply_recipes (
    host TEXT PRIMARY KEY,
    reveal_labels TEXT DEFAULT '[]',     -- JSON array: labels that advanced the flow
    login_required INTEGER DEFAULT 0,
    captcha_gated INTEGER DEFAULT 0,
    closed_posting INTEGER DEFAULT 0,
    last_outcome TEXT,                   -- stopped_for_review | error | login_required | ...
    attempts INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- In-app job sync history. One row per sync run (quick/full) triggered from the UI, so
  -- "last synced" survives server restarts. The live/in-progress state lives in a module
  -- singleton (src/lib/sync.ts); this table is the durable summary.
  CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,                 -- 'quick' | 'full'
    status TEXT NOT NULL,               -- 'running' | 'done' | 'error' | 'cancelled'
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    steps_done INTEGER DEFAULT 0,
    steps_total INTEGER DEFAULT 0,
    error TEXT
  );

  -- Multi-resume library. The user keeps several resumes (e.g. a generic one + a
  -- healthcare-specific one) and switches which is active. The ACTIVE resume is mirrored into
  -- my_profile (id=1) so every consumer (matcher, evaluate, generate, apply) keeps reading the
  -- singleton unchanged — this table is the library, my_profile is the live "active profile".
  CREATE TABLE IF NOT EXISTS resumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    raw_text TEXT,
    parsed_json TEXT,
    embedding BLOB,
    is_active INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Read-through cache for the ranked match list. One row per view variant (cache_key encodes
  -- the include_hidden / include_expired flags). The heavy vector scan + JS re-rank runs only
  -- when \`signature\` (a cheap fingerprint of profile + job/eval state) changes; otherwise the
  -- serialized ranked list in \`payload\` is served directly. Replaces the old write-only
  -- match_results cache on the hot path. See src/lib/matches.ts.
  CREATE TABLE IF NOT EXISTS match_cache (
    cache_key TEXT PRIMARY KEY,
    signature TEXT,
    payload TEXT,
    computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Small key/value store for app-level metadata. Currently holds 'embedding_signature'
  -- (provider:model of the DB's embeddings) — see src/lib/embedding-signature.ts.
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Seed the resumes library from the pre-existing singleton profile, so upgrading users keep
// their current resume as the first (active) entry. Runs once (only when the table is empty).
try {
  const haveResumes = db.prepare('SELECT COUNT(*) n FROM resumes').get() as { n: number };
  if (haveResumes.n === 0) {
    const prof = db.prepare('SELECT raw_text, parsed_json, embedding FROM my_profile WHERE id = 1').get() as
      | { raw_text: string | null; parsed_json: string | null; embedding: Buffer | null }
      | undefined;
    if (prof && prof.parsed_json) {
      let label = 'My Resume';
      try { const p = JSON.parse(prof.parsed_json); if (p?.name) label = `${p.name}`; } catch { /* keep default */ }
      db.prepare('INSERT INTO resumes (label, raw_text, parsed_json, embedding, is_active) VALUES (?, ?, ?, ?, 1)')
        .run(label, prof.raw_text, prof.parsed_json, prof.embedding);
    }
  }
} catch { /* resumes table may not be ready on a brand-new DB — safe to skip */ }

  // One-time backfill of the embedding signature. Before embeddings became provider-configurable,
  // everything was embedded with Ollama. If a DB already has embeddings but no recorded signature,
  // seed it to Ollama so the provider-mismatch guard (src/lib/embedding-signature.ts) also protects
  // pre-existing corpora. Fresh/empty DBs get no signature — the first embed records it.
  try {
    const hasSig = db.prepare("SELECT 1 FROM app_meta WHERE key = 'embedding_signature'").get();
    if (!hasSig) {
      const embedded =
        db.prepare('SELECT 1 FROM job_postings WHERE embedding IS NOT NULL LIMIT 1').get() ||
        db.prepare('SELECT 1 FROM my_profile WHERE embedding IS NOT NULL LIMIT 1').get();
      if (embedded) {
        const sig = `ollama:${process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text'}`;
        db.prepare("INSERT INTO app_meta (key, value) VALUES ('embedding_signature', ?)").run(sig);
      }
    }
  } catch { /* tables may not be ready — safe to skip */ }

// Additive migrations for existing databases. ALTER TABLE ADD COLUMN is idempotent-ish via try/catch —
// SQLite throws "duplicate column" if the column already exists, which we swallow.
// The kinds `llm_providers.kind` accepts. Keep in sync with `ProviderKind` in src/lib/llm.ts
// and VALID_KINDS in src/app/api/providers/route.ts.
const PROVIDER_KINDS = ['gemini', 'openai', 'anthropic', 'openai-compatible', 'ollama', 'freeway'] as const;

/**
 * Rebuild `llm_providers` when its CHECK constraint is missing a kind we now support.
 * SQLite has no ALTER for CHECK, so this is create-copy-drop-rename inside a transaction:
 * either the whole swap lands or the original table is untouched.
 */
function migrateProviderKinds(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='llm_providers'").get() as
    | { sql: string }
    | undefined;
  if (!row?.sql) return;
  // Already permits every kind we know about → nothing to do (the common case).
  if (PROVIDER_KINDS.every((k) => row.sql.includes(`'${k}'`))) return;

  const checkList = PROVIDER_KINDS.map((k) => `'${k}'`).join(',');
  const oldCols = (db.prepare('PRAGMA table_info(llm_providers)').all() as Array<{ name: string }>).map((c) => c.name);
  // Copy only columns that exist on BOTH sides, so an older DB missing a column (or a newer one
  // carrying an extra) still migrates instead of throwing mid-transaction.
  const newCols = ['id', 'kind', 'display_name', 'model', 'api_key', 'base_url', 'is_active', 'created_at', 'is_creative', 'cooldown_until'];
  const shared = newCols.filter((c) => oldCols.includes(c));
  const cols = shared.join(', ');

  db.exec('PRAGMA foreign_keys=OFF');
  const swap = db.transaction(() => {
    db.exec(`
      CREATE TABLE llm_providers_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK(kind IN (${checkList})),
        display_name TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT,
        base_url TEXT,
        is_active INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_creative INTEGER DEFAULT 0,
        cooldown_until DATETIME
      );
      INSERT INTO llm_providers_migrated (${cols}) SELECT ${cols} FROM llm_providers;
      DROP TABLE llm_providers;
      ALTER TABLE llm_providers_migrated RENAME TO llm_providers;
    `);
  });
  const before = (db.prepare('SELECT COUNT(*) AS c FROM llm_providers').get() as { c: number }).c;
  swap();
  const after = (db.prepare('SELECT COUNT(*) AS c FROM llm_providers').get() as { c: number }).c;
  db.exec('PRAGMA foreign_keys=ON');
  console.log(`[db] llm_providers rebuilt to allow kinds (${checkList}) — ${before} row(s) in, ${after} out`);
}

const ADDITIVE_COLUMNS: Array<[string, string]> = [
  ['job_postings', 'remote_policy TEXT'],
  ['job_postings', 'visa_sponsorship INTEGER DEFAULT 0'],
  ['job_postings', 'relocation_offered INTEGER DEFAULT 0'],
  ['job_postings', "apply_type TEXT DEFAULT 'unknown'"], // easy_apply | direct_apply | external | unknown
  ['job_postings', 'source_platform TEXT'], // exact platform behind an aggregator source
  // Lazy-formatted (LLM-cleaned) version of the description. NULL = not yet formatted.
  ['job_postings', 'description_formatted TEXT'],
  // User-dismissed jobs ("not interested"). NULL = visible. Set = hidden from default match list.
  ['job_postings', 'hidden_at DATETIME'],
  // Phase 2 — application tracker upgrades
  ['my_applications', 'applied_date TEXT'],
  ['my_applications', 'recruiter_name TEXT'],
  ['my_applications', 'recruiter_contact TEXT'],
  ['my_applications', 'next_follow_up_at TEXT'],
  ['my_applications', 'last_status_change_at DATETIME'],
  // Mark a provider as the creative-lane target (cover-letter / resume-variant generation).
  // At most one provider should have this set; runtime takes the first match. Optional —
  // if no provider is flagged, creative lane uses Gemini Pro→Flash with env key.
  ['llm_providers', 'is_creative INTEGER DEFAULT 0'],
  // Fallback chain: when a provider/key hits its quota (429), it's put on cooldown until this
  // timestamp and skipped, so the chain rotates to the next key and finally to Ollama.
  ['llm_providers', 'cooldown_until DATETIME'],
  // Auto-apply tracking — distinct from `applied_at` (row creation) and `last_status_change_at`
  // because we want to record HOW the submission was sent.
  ['my_applications', 'submitted_via TEXT'],        // 'greenhouse' | 'ashby' | 'lever' | 'browser' | 'linkedin'
  ['my_applications', 'submitted_at DATETIME'],     // when the submission was actually sent
  ['my_applications', 'submission_id TEXT'],        // portal-returned application ID, if any
  ['my_applications', 'submission_error TEXT'],     // null on success
  ['my_applications', 'submission_payload TEXT'],   // JSON snapshot of what we sent (audit)
  // Freshness & validity engine (Phase 1). Ingestion upserts last_seen_at + source_present
  // every run; prune-stale retires jobs that vanished; verify-links records URL liveness.
  ['job_postings', 'last_seen_at DATETIME'],        // refreshed each time re-seen at source
  ['job_postings', 'posted_at TEXT'],               // source's posting date where exposed
  ['job_postings', 'source_present INTEGER DEFAULT 1'], // 1 if seen in latest run of its source
  ['job_postings', 'url_status TEXT'],              // 'live' | 'dead' | 'unknown'
  ['job_postings', 'url_checked_at DATETIME'],      // when url_status was last verified
  ['job_postings', 'expired_at DATETIME'],          // set when auto-retired (delisted / dead link)
  // Original resume PDF bytes, so the user can submit their real resume instead of the
  // AI-tailored one. Stored per resume; mirrored onto my_profile (the active profile).
  ['resumes', 'pdf_blob BLOB'],
  ['resumes', 'pdf_filename TEXT'],
  ['my_profile', 'pdf_blob BLOB'],
  ['my_profile', 'pdf_filename TEXT'],
  // The user's Overleaf/LaTeX resume TEMPLATE (their .tex source, design preserved). When present
  // AND a LaTeX compiler is installed, tailored resumes are generated by having the LLM edit THIS
  // template and compiling the result — instead of the fallback Markdown→HTML template. Mirrored
  // to my_profile like pdf_blob; the tailored .tex output is cached per job in job_documents.
  ['resumes', 'resume_tex TEXT'],
  ['my_profile', 'resume_tex TEXT'],
  ['job_documents', 'resume_tex TEXT'],
  ['my_applications', 'resume_tex TEXT'],
  ['my_applications', 'resume_source TEXT'],
  ['my_applications', 'tailored_score REAL'],
  ['my_applications', 'default_score REAL'],
  ['job_documents', 'tailored_score REAL'],
  ['job_documents', 'default_score REAL'],
  // Live sync progress — persisted so the UI reads true state even if the Next dev server
  // recompiles/restarts (in-memory tracking doesn't survive that). The detached orchestrator
  // (scripts/run-sync.ts) writes these; getSyncStatus reads them.
  ['sync_runs', 'current_step TEXT'],
  ['sync_runs', 'step_index INTEGER DEFAULT 0'],
  ['sync_runs', 'steps_json TEXT'],          // [{label,status}] for the UI checklist
  ['sync_runs', 'log_tail TEXT'],            // JSON array of recent log lines
  ['sync_runs', 'updated_at DATETIME'],      // heartbeat — stale => run died
  ['sync_runs', 'pid INTEGER'],              // orchestrator pid (for cancel)
  ['sync_runs', 'cancel_requested INTEGER DEFAULT 0'],
  // Negative-result caching for the lazy scrape caches: a row with not_found=1 records that we
  // checked and the company has no Levels.fyi / Ambitionbox page, so we stop re-scraping every
  // view. Honored within a TTL (see the routes); an explicit ?refresh=1 re-checks.
  ['compensation_data', 'not_found INTEGER DEFAULT 0'],
  ['ambitionbox_data', 'not_found INTEGER DEFAULT 0'],
];
  for (const [table, spec] of ADDITIVE_COLUMNS) {
    // Skip tables created later in this same init (e.g. job_documents) on a fresh DB.
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${spec}`);
    } catch (e) {
      if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
    }
  }

  // The ONE non-additive migration. `llm_providers.kind` is constrained by a CHECK, and SQLite
  // cannot ALTER a CHECK — so adding the 'freeway' kind means rebuilding the table. Guarded by
  // sniffing the stored DDL, so it runs exactly once and is a no-op on a fresh DB (whose CREATE
  // above already lists 'freeway'). Columns are copied by the intersection of old and new, so
  // any additive column added later survives. If a future kind is needed, extend KINDS and the
  // guard picks it up.
  migrateProviderKinds(db);

  // Indexes. These are created AFTER the ALTER loop because several target columns
  // (hidden_at, expired_at, url_status) are added additively above. The partial index on
  // embedding speeds the "embedded count" used by the match-cache signature. None of these
  // help the vec_distance_cosine sort itself (that's a full scan by nature) — the match-cache
  // is what removes that cost from the hot path.
  db.exec(`
    CREATE INDEX IF NOT EXISTS job_embedded_idx ON job_postings(id) WHERE embedding IS NOT NULL;
    CREATE INDEX IF NOT EXISTS job_hidden_idx ON job_postings(hidden_at);
    CREATE INDEX IF NOT EXISTS job_expired_idx ON job_postings(expired_at);
    CREATE INDEX IF NOT EXISTS job_url_status_idx ON job_postings(url_status);
    -- source + last_seen_at: markSourceAbsent() runs
    -- "UPDATE job_postings SET source_present=0 WHERE source=?" once per ingest script (12-13x
    -- per full sync), which was a full scan + rewrite each time. prune filters on last_seen_at.
    CREATE INDEX IF NOT EXISTS job_source_idx ON job_postings(source);
    CREATE INDEX IF NOT EXISTS job_last_seen_idx ON job_postings(last_seen_at);
    -- Read-time duplicate collapsing groups by company + title (19% of active rows were
    -- near-duplicates: one role posted to N locations = N rows, since dedup_hash includes location).
    CREATE INDEX IF NOT EXISTS job_company_title_idx ON job_postings(company, title);
  `);

  // Normalize date formats in my_applications so sorting and filtering is consistently ISO-8601 (T instead of space)
  try {
    db.exec(`
      UPDATE my_applications SET applied_at = REPLACE(applied_at, ' ', 'T') WHERE applied_at LIKE '% %';
      UPDATE my_applications SET last_status_change_at = REPLACE(last_status_change_at, ' ', 'T') WHERE last_status_change_at LIKE '% %';
      UPDATE my_applications SET applied_at = COALESCE(applied_at, submitted_at, last_status_change_at, applied_date || 'T00:00:00.000Z') WHERE applied_at IS NULL;
    `);
  } catch {
    /* ignore */
  }

  // Per-job skill extraction cache. Scanning a description against the ~175-entry skill
  // vocabulary costs ~6ms; over the ~1,600 candidates a recompute scores that is ~10 SECONDS, and
  // it was being redone on every cache miss. A job's title/description never change after ingest,
  // so the extraction is constant per job — only the comparison against the résumé is per-profile.
  // Measured: this is what took the cold recompute from 1.2s to 21s when skill fit was added.
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_skills (
      job_id INTEGER PRIMARY KEY,
      title_skills TEXT NOT NULL,
      body_skills TEXT NOT NULL,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- ON DELETE CASCADE: this is a pure extraction cache, not history. Without the cascade its FK
      -- made 331 otherwise-orphaned tombstones permanently unpurgeable (measured), because the
      -- purge guard has to protect any row something references.
      FOREIGN KEY (job_id) REFERENCES job_postings(id) ON DELETE CASCADE
    );
  `);

  // Rebuild job_skills if it predates the CASCADE (SQLite cannot ALTER a foreign key). Safe to drop
  // outright — every row is recomputed on the next cache miss.
  try {
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='job_skills'`).get() as { sql?: string } | undefined)?.sql || '';
    if (ddl && !/ON DELETE CASCADE/i.test(ddl)) {
      db.exec('DROP TABLE job_skills;');
      db.exec(`
        CREATE TABLE job_skills (
          job_id INTEGER PRIMARY KEY,
          title_skills TEXT NOT NULL,
          body_skills TEXT NOT NULL,
          computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (job_id) REFERENCES job_postings(id) ON DELETE CASCADE
        );
      `);
    }
  } catch { /* leave it as-is if the rebuild fails; it is only a cache */ }

  // Directory of company career boards: which ATS a company uses, and its board URL.
  //
  // WHY THIS EXISTS: seeding used to be manual, and for Workday it was close to impossible — a pull
  // needs tenant + data-centre host + site, none of which can be guessed from a company name (15
  // probes across Kaiser/HCA/Providence/Cigna/Elevance found zero working boards). This table holds
  // ~80k companies that arrive WITH their board URL, so adding an employer is a search-and-click.
  //
  // It is a DIRECTORY, never a job source. Boards are still pulled fresh by our own adapters, so
  // the postings are ours and current; only the company->ATS mapping comes from outside, and that
  // changes slowly. Populate with `npm run sync:directory`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ats_companies (
      ats TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      url TEXT,
      PRIMARY KEY (ats, slug)
    );
    CREATE INDEX IF NOT EXISTS ats_companies_name_idx ON ats_companies(name COLLATE NOCASE);
  `);

  // Generated cover letters / resume variants, cached per job.
  //
  // WHY THIS TABLE EXISTS: generating these costs an LLM call, so they were cached — but the cache
  // was `my_applications`, and when no application existed the code INSERTED one with
  // `status = 'applied'`. Merely OPENING the auto-apply preview therefore recorded a fabricated
  // application. That was cosmetic until the matcher started excluding applied jobs by default, at
  // which point previewing a job silently deleted it from the match list, the digest and all three
  // rating paths. Three such rows existed in the live DB, none with `submitted_via` or any
  // `apply_audit` entry.
  //
  // ON DELETE CASCADE is deliberate and differs from every other table referencing job_postings:
  // this is derived data, not history, so it must never block a purge (see `referencingTables` in
  // scripts/prune-stale.ts, which skips cascading refs for exactly this reason).
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_documents (
      job_id INTEGER PRIMARY KEY,
      cover_letter TEXT,
      resume_variant TEXT,
      resume_tex TEXT,
      tailored_score REAL,
      default_score REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES job_postings(id) ON DELETE CASCADE
    );
  `);

  // Invalidate the extraction if a job's text ever changes, mirroring what the FTS triggers do.
  //
  // Today only `description_formatted` is ever rewritten (by the "Tidy up" route), so `title` and
  // `description` are in practice immutable after ingest and this never fires. That is precisely
  // why it is worth having: the cache's correctness currently rests on an invariant nothing
  // enforces, and the day an ingest script starts refreshing descriptions on re-seen postings,
  // every affected job would keep serving skills extracted from text that no longer exists.
  // Deleting the row is enough — `computeRanked` re-extracts on a miss.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS job_skills_invalidate
    AFTER UPDATE OF title, description ON job_postings BEGIN
      DELETE FROM job_skills WHERE job_id = old.id;
    END;
  `);

  // Drop the superseded `match_results` table.
  //
  // It was the v1 per-job score cache and has not been WRITTEN since `match_cache` landed — its
  // newest row is from 2026-07-18 and stores `final_score: 1.039`, i.e. the old unbounded
  // `cosine + boosts` score from before the bounded composite. Nothing reads it. It was not
  // harmless: it holds a foreign key to `job_postings`, so its 30 dead rows blocked exactly 30
  // expired postings from ever being purged. Everything in it is derived data that `match_cache`
  // recomputes, so there is nothing to preserve.
  try {
    db.exec('DROP TABLE IF EXISTS match_results;');
  } catch { /* already gone */ }

  setupJobFts(db);

  return db;
}

/**
 * FTS5 full-text index over job_postings, for hybrid (lexical + vector) retrieval.
 *
 * WHY: ranking on embedding cosine alone cannot tell "Solution Architect (FHIR)" from "Solution
 * Architect (Java/Spring)" — both are topically near-identical to a senior architect résumé, and
 * `nomic-embed-text` cosine only spans ~0.29-0.83 over this corpus. BM25 catches the exact terms
 * that matter (FHIR, HL7, Java) and the two rankings are fused with Reciprocal Rank Fusion in
 * `src/lib/matches.ts`. FTS5 ships with SQLite, so this adds no dependency.
 *
 * `content='job_postings'` makes this an external-content index: the text is NOT duplicated, FTS5
 * reads it from the base table via `content_rowid`. `job_postings.id` is INTEGER PRIMARY KEY, so it
 * IS the rowid, which is what external content requires.
 *
 * The UPDATE trigger is deliberately `AFTER UPDATE OF title, description, company` and NOT a bare
 * `AFTER UPDATE`. Every ingest upsert touches `last_seen_at`/`source_present` on rows it re-sees —
 * ~10,000 per full sync — and a bare trigger would re-index the whole corpus every run for nothing.
 */
function setupJobFts(db: Database.Database): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS job_fts USING fts5(
        title, company, description,
        content='job_postings',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS job_fts_ai AFTER INSERT ON job_postings BEGIN
        INSERT INTO job_fts(rowid, title, company, description)
        VALUES (new.id, new.title, new.company, new.description);
      END;

      CREATE TRIGGER IF NOT EXISTS job_fts_ad AFTER DELETE ON job_postings BEGIN
        INSERT INTO job_fts(job_fts, rowid, title, company, description)
        VALUES ('delete', old.id, old.title, old.company, old.description);
      END;

      CREATE TRIGGER IF NOT EXISTS job_fts_au AFTER UPDATE OF title, description, company ON job_postings BEGIN
        INSERT INTO job_fts(job_fts, rowid, title, company, description)
        VALUES ('delete', old.id, old.title, old.company, old.description);
        INSERT INTO job_fts(rowid, title, company, description)
        VALUES (new.id, new.title, new.company, new.description);
      END;
    `);

    // One-time backfill for a database that already has rows (the triggers only cover future
    // writes). Self-heals if the index is ever dropped or left half-built.
    //
    // CAREFUL — do NOT test emptiness with `SELECT COUNT(*) FROM job_fts`. On an external-content
    // table that query reads the CONTENT table (job_postings), so it returns the full row count
    // even when the index holds nothing, and the backfill would never run. (Caught in testing:
    // count said 10,721 while every MATCH returned zero rows.) Probe with an actual MATCH
    // instead — any corpus of job postings contains at least one of these words.
    const jobCount = (db.prepare('SELECT COUNT(*) n FROM job_postings').get() as { n: number }).n;
    const indexed = jobCount === 0
      ? true
      : !!db.prepare(
          "SELECT rowid FROM job_fts WHERE job_fts MATCH 'engineer OR manager OR architect OR developer OR analyst OR director' LIMIT 1",
        ).get();
    if (!indexed) {
      const started = Date.now();
      // 'rebuild' is FTS5's own command for repopulating an external-content index from its
      // content table. Preferred over a manual INSERT...SELECT: it cannot drift out of sync.
      db.exec("INSERT INTO job_fts(job_fts) VALUES('rebuild')");
      console.log(`[db] job_fts built from ${jobCount} rows in ${Date.now() - started}ms`);
    }
  } catch (e) {
    // FTS5 is compiled into every mainstream SQLite build, but if it somehow isn't, hybrid
    // retrieval must degrade to vector-only rather than taking the app down.
    console.warn(`[db] FTS5 unavailable — hybrid search will fall back to vector-only: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** True when the FTS index is present and usable, so the matcher can skip the lexical leg. */
export function jobFtsAvailable(): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job_fts'").get();
    return !!row;
  } catch {
    return false;
  }
}

const db = globalForDb.__hiresignalDb ?? initDb();
if (process.env.NODE_ENV !== 'production') globalForDb.__hiresignalDb = db;

export default db;
