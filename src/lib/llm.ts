import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai';
import db, { addSystemNotification } from './db';
import { askText as freewayAsk, freewayBaseUrl, freewayTimeoutFor, isFreewayEnabled, pointsAtFreeway } from './freeway';
import { extractJdKeywords, matchKeywordsInText, type JdKeyword } from './jd-keywords';
import { recordLLMUsage } from './llm-models';


const ANTHROPIC_MODEL_ENV = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_CREATIVE_MODEL_ENV = process.env.GEMINI_CREATIVE_MODEL || 'gemini-3.8-flash';
/** Where the creative lane lands when primary model is rate-limited or unavailable. Verified working. */
const GEMINI_CREATIVE_FALLBACK_MODEL = process.env.GEMINI_CREATIVE_FALLBACK_MODEL || 'gemini-3.8-flash';

// ---------------------------------------------------------------------------
// Provider resolution: DB-first (user-configured via /settings) with env fallback.
// Resolved on every call, with a 30s cache so we pick up settings changes within
// a half-minute without paying the DB query cost on every LLM invocation.
// ---------------------------------------------------------------------------

// 'freeway' is env-sourced ONLY (see freewayEnvConfig) — `llm_providers.kind` has a CHECK
// constraint that predates it, so there is never a DB row with this kind.
export type ProviderKind = 'gemini' | 'openai' | 'anthropic' | 'openai-compatible' | 'ollama' | 'freeway'; // 'ollama' kept for DB compatibility only — ignored at runtime

interface ProviderConfig {
  id?: number;            // llm_providers row id (for cooldown updates)
  kind: ProviderKind;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  source: 'db' | 'env';
  isActive?: boolean;     // the user's explicit /settings choice
}

interface ProviderCache {
  config: ProviderConfig;
  gemini?: GoogleGenerativeAI;
  anthropic?: Anthropic;
  ts: number;
}
let providerCache: ProviderCache | null = null;

export const GEMINI_MODEL_POOL = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
];

export interface GeminiTestResult {
  ok: boolean;
  reason?: string;
  simpleReason?: string;
}

const modelVerificationCache = new Map<string, { ok: boolean; ts: number; reason?: string; simpleReason?: string }>();

function resolveProviderConfig(): ProviderConfig {
  // Try DB-active provider first
  try {
    const row = db
      .prepare('SELECT kind, model, api_key, base_url FROM llm_providers WHERE is_active = 1 LIMIT 1')
      .get() as { kind: ProviderKind; model: string; api_key: string | null; base_url: string | null } | undefined;
    if (row) {
      return {
        kind: row.kind,
        model: row.model,
        apiKey: row.api_key,
        baseUrl: row.base_url,
        source: 'db',
      };
    }
  } catch {
    // Table may not exist yet on first boot — fall through to env
  }
  // Env-based fallback (preserves prior behavior)
  if (process.env.GEMINI_API_KEY) {
    return { kind: 'gemini', model: GEMINI_MODEL_ENV, apiKey: process.env.GEMINI_API_KEY, baseUrl: null, source: 'env' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: 'anthropic', model: ANTHROPIC_MODEL_ENV, apiKey: process.env.ANTHROPIC_API_KEY, baseUrl: null, source: 'env' };
  }
  // Freeway: with no cloud key configured, use the local gateway over ~32 free-tier providers.
  const freeway = freewayEnvConfig();
  if (freeway) return freeway;
  // No provider configured at all — throw a clear error rather than silently using Ollama.
  throw new Error('No LLM provider configured. Add a Gemini API key in Settings or set GEMINI_API_KEY in .env.local.');
}

function getProvider(): ProviderCache {
  if (providerCache && Date.now() - providerCache.ts < 30_000) return providerCache;
  const config = resolveProviderConfig();
  providerCache = {
    config,
    gemini: config.kind === 'gemini' && config.apiKey ? new GoogleGenerativeAI(config.apiKey) : undefined,
    anthropic: config.kind === 'anthropic' && config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : undefined,
    ts: Date.now(),
  };
  return providerCache;
}

// "Creative lane" — used by cover-letter / resume-variant. Resolution order:
//   1. If a provider in `llm_providers` is flagged is_creative=1, use that (user opt-in).
//   2. Else if a Gemini key is available (DB or env), use Gemini Pro→Flash.
//   3. Else fall back to the active primary provider.
// (1) lets users opt into Anthropic Sonnet / Claude / paid models for application docs
// while keeping their structured calls on a free/fast provider like Groq.

interface CreativeProviderRow {
  kind: ProviderKind;
  model: string;
  api_key: string | null;
  base_url: string | null;
}

let creativeProviderCache: { row: CreativeProviderRow | null; ts: number } | null = null;
function getCreativeProvider(): CreativeProviderRow | null {
  if (creativeProviderCache && Date.now() - creativeProviderCache.ts < 30_000) {
    return creativeProviderCache.row;
  }
  let row: CreativeProviderRow | null = null;
  try {
    const r = db
      .prepare('SELECT kind, model, api_key, base_url FROM llm_providers WHERE is_creative = 1 LIMIT 1')
      .get() as CreativeProviderRow | undefined;
    if (r) row = r;
  } catch { /* table or column may not exist yet on first boot */ }
  creativeProviderCache = { row, ts: Date.now() };
  return row;
}

let creativeGeminiCache: { client: GoogleGenerativeAI; ts: number } | null = null;
function getCreativeGeminiClient(): GoogleGenerativeAI | null {
  if (creativeGeminiCache && Date.now() - creativeGeminiCache.ts < 30_000) {
    return creativeGeminiCache.client;
  }
  // Prefer a DB-stored Gemini provider (lets user supply key via /settings).
  let key: string | null = null;
  try {
    const row = db
      .prepare("SELECT api_key FROM llm_providers WHERE kind = 'gemini' AND api_key IS NOT NULL ORDER BY is_active DESC LIMIT 1")
      .get() as { api_key: string } | undefined;
    if (row?.api_key) key = row.api_key;
  } catch { /* table may not exist yet */ }
  if (!key && process.env.GEMINI_API_KEY) key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const client = new GoogleGenerativeAI(key);
  creativeGeminiCache = { client, ts: Date.now() };
  return client;
}

// Force-invalidate caches (called by /api/providers/[id]/activate or creative-flag flow)
export function invalidateProviderCache() {
  providerCache = null;
  creativeProviderCache = null;
  creativeGeminiCache = null;
  modelVerificationCache.clear();
}

// Tracks which provider actually produced the last successful result (set by callWithProviders),
// so the DB stamp reflects the provider that did the work — not just the configured active one.
let lastUsedProviderKind: string | null = null;

// Used by routes that need to record which provider produced an evaluation/brief.
export function getActiveProviderName(): string {
  return lastUsedProviderKind ?? getProvider().config.kind;
}

// ---------------------------------------------------------------------------
// Provider fallback chain — rotate active → other configured keys → Freeway.
// On a quota/429 error, put that provider on cooldown (skipped by buildProviderChain until it
// expires) and move to the next. This makes on-demand AI degrade gracefully instead of 429-ing.
// ---------------------------------------------------------------------------

function isQuotaError(msg: string): boolean {
  return /429|500|502|503|quota|rate.?limit|RESOURCE_EXHAUSTED|Too Many Requests|exceeded your current quota|high demand|Service Unavailable|overloaded|Error fetching from https:\/\/generativelanguage\.googleapis\.com|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/**
 * A provider whose CONFIGURED MODEL no longer exists.
 *
 * Distinct from a quota error: retrying tomorrow won't help, because the model is gone. Providers
 * decommission models (Groq retired `llama-3.3-70b-versatile`), and a stale row then 404s on EVERY
 * call — a guaranteed wasted round-trip in every single failover, forever, with a scary log line
 * each time. Detecting it lets us park the row instead of re-learning it on every request.
 */
function isModelGoneError(msg: string): boolean {
  return /does not exist|no longer available|model not found|404.*model|unknown model|decommissioned/i.test(msg);
}

// Put a provider row on cooldown. Daily-quota errors → 6h; per-minute rate limits → 90s;
// a decommissioned model → 7 days (it needs a human to pick a new model in /settings).
function markCooldown(id: number | undefined, msg: string): void {
  if (id == null) return;
  try {
    if (isModelGoneError(msg)) {
      db.prepare("UPDATE llm_providers SET cooldown_until = datetime('now', '+7 days') WHERE id = ?").run(id);
      console.warn('[llm] provider parked for 7 days — its configured model no longer exists. Pick a current model in /settings.');
      return;
    }
    const isDaily = /per day|quota|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(msg);
    const seconds = isDaily ? 6 * 60 * 60 : 90;
    db.prepare("UPDATE llm_providers SET cooldown_until = datetime('now', ?) WHERE id = ?")
      .run(seconds >= 0 ? '+' + seconds + ' seconds' : '+90 seconds', id);
  } catch {
    /* best-effort — cooldown is an optimization, not a correctness requirement */
  }
}

// Freeway — the local AI gateway (~32 free-tier providers, own failover). Env-sourced only:
// `llm_providers.kind`'s CHECK constraint predates this kind, so it is never a DB row. It sits
// between the user's own keys when a cloud key hits its daily quota.
function freewayEnvConfig(): ProviderConfig | null {
  if (!isFreewayEnabled()) return null;
  return {
    kind: 'freeway',
    model: process.env.FREEWAY_MODEL || 'auto',
    apiKey: null,
    baseUrl: freewayBaseUrl(),
    source: 'env',
  };
}

// Append Freeway to chain if not already present.
function chainTail(dbProviders: ProviderConfig[] = []): ProviderConfig[] {
  const alreadyQueued = dbProviders.some((c) => c.kind === 'freeway' || pointsAtFreeway(c.baseUrl));
  const freeway = alreadyQueued ? null : freewayEnvConfig();
  return freeway ? [freeway] : [];
}

// Build the ordered provider chain: DB rows not on cooldown (active-first), then Freeway.
// Ollama DB rows are silently skipped — Ollama is no longer supported.
function buildProviderChain(): ProviderConfig[] {
  try {
    const rows = db
      .prepare(
        "SELECT id, kind, model, api_key, base_url, is_active FROM llm_providers WHERE cooldown_until IS NULL OR cooldown_until <= datetime('now') ORDER BY is_active DESC, id ASC",
      )
      .all() as Array<{ id: number; kind: ProviderKind; model: string; api_key: string | null; base_url: string | null; is_active: number }>;

    if (rows.length === 0) return envOnlyChain();

    const dbProviders: ProviderConfig[] = [];
    for (const r of rows) {
      if (r.kind === 'ollama') continue; // Ollama removed — skip any legacy DB rows
      dbProviders.push({
        id: r.id,
        kind: r.kind,
        model: r.model,
        apiKey: r.api_key,
        baseUrl: r.base_url,
        source: 'db',
        isActive: r.is_active === 1,
      });
    }
    if (dbProviders.length === 0) return envOnlyChain();
    return [...dbProviders, ...chainTail(dbProviders)];
  } catch {
    return envOnlyChain();
  }
}

// No usable DB rows (empty table or DB error): resolve from env, then append Freeway tail.
function envOnlyChain(): ProviderConfig[] {
  try {
    const primary = resolveProviderConfig();
    if (primary.kind === 'freeway') return [primary];
    return [primary, ...chainTail([primary])];
  } catch {
    // No provider configured at all — return empty; callWithProviders will throw a clear error.
    return [];
  }
}

/**
 * Hard ceiling on any single provider attempt.
 *
 * WHY THIS EXISTS: nothing in this file had a timeout — the raw fetches carried no AbortSignal and
 * the Gemini/Anthropic SDKs default to none. A single hung provider therefore pinned the awaiting
 * API route forever. That is not theoretical: one `/api/jobs/[id]/format` call hung past 300s and
 * every route on the dev server returned 500 from then on, with the process stuck at ~940MB until
 * it was killed.
 *
 * Bounding it HERE rather than at the route is deliberate: a timeout becomes an ordinary provider
 * failure, so `callWithProviders` rotates to the next provider instead of failing the request.
 */
const LLM_CALL_TIMEOUT_MS = parseInt(process.env.LLM_CALL_TIMEOUT_MS || '', 10) || 120_000;

/**
 * Ceiling for a call a HUMAN is waiting on, e.g. pressing "Write one" for a cover letter.
 *
 * Batch work and interactive work need different patience. Freeway scales its own timeout with the
 * token budget so a long structured evaluation isn't pre-empted — 4096 tokens gives 245,760ms — and
 * applying that to a button click meant the user waited **4 minutes 8 seconds** for a failure
 * (measured: `POST /api/generate/cover-letter 500 in 248292ms`). Nobody waits that long; they
 * conclude it is broken, and they are right to. Interactive callers pass this instead and get a
 * clear failure fast enough to act on.
 */
export const LLM_INTERACTIVE_TIMEOUT_MS =
  parseInt(process.env.LLM_INTERACTIVE_TIMEOUT_MS || '', 10) || 75_000;

class LlmTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    // Belt-and-braces: tsconfig now targets ES2017, but this keeps `instanceof` correct if that
    // ever changes (at ES5, subclassing Error loses the prototype). See freeway.ts for the history.
    Object.setPrototypeOf(this, LlmTimeoutError.prototype);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * Race a provider call against the ceiling. NOTE: this frees the REQUEST, it does not cancel the
 * upstream work — the underlying fetch keeps running until it completes or the socket dies. The
 * per-fetch AbortSignals added alongside this are what actually cancel; this is the backstop for
 * paths we don't control (the vendor SDKs).
 */
function withLlmTimeout<T>(work: Promise<T>, label: string, ms = LLM_CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LlmTimeoutError(label, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Fast ping test for a specific Gemini model before proceeding with heavy work.
 * Returns ok: true if healthy, or ok: false with a simple reason if rate-limited / high-demand / quota exceeded.
 */
export async function testGeminiModel(modelName: string, apiKey: string, skipCache = false): Promise<GeminiTestResult> {
  if (!skipCache) {
    const cached = modelVerificationCache.get(modelName);
    if (cached && Date.now() - cached.ts < 45_000) {
      return { ok: cached.ok, reason: cached.reason, simpleReason: cached.simpleReason };
    }
  }

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({
      model: modelName,
      generationConfig: { maxOutputTokens: 2 },
    });
    await withLlmTimeout(model.generateContent('ping'), `ping ${modelName}`, 7000);
    const res = { ok: true };
    modelVerificationCache.set(modelName, { ok: true, ts: Date.now() });
    return res;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    let simpleReason = 'failed limit check';
    if (/503|high demand|overloaded|Service Unavailable/i.test(msg)) {
      simpleReason = 'is experiencing high demand';
    } else if (/429|quota|rate.?limit|RESOURCE_EXHAUSTED|Too Many Requests|exceeded your current quota/i.test(msg)) {
      simpleReason = 'reached quota limit';
    } else if (/404|not found|no longer available|discontinued/i.test(msg)) {
      simpleReason = 'is discontinued or unavailable';
    } else if (/timed out/i.test(msg)) {
      simpleReason = 'response timed out';
    }

    const res = { ok: false, reason: msg, simpleReason };
    modelVerificationCache.set(modelName, { ok: false, ts: Date.now(), reason: msg, simpleReason });
    return res;
  }
}

/**
 * Dynamically switch active Gemini model to the next available working model from the pool.
 * Updates llm_providers table, invalidates cache, and notifies the UI with a simple explanation.
 */
export async function switchGeminiModel(
  currentModel: string,
  apiKey: string,
  reason?: string,
): Promise<{ model: string; newModel: string; switched: boolean; message?: string }> {
  const candidates = GEMINI_MODEL_POOL.filter((m) => m !== currentModel);
  let workingModel: string | null = null;
  const detectedReason = reason || 'reached quota limit';

  console.log(`[llm] Testing candidate Gemini models to replace ${currentModel} (${detectedReason})...`);

  for (const candidate of candidates) {
    const cached = modelVerificationCache.get(candidate);
    if (cached && !cached.ok && Date.now() - cached.ts < 60_000) {
      continue;
    }

    const testRes = await testGeminiModel(candidate, apiKey, true);
    if (testRes.ok) {
      workingModel = candidate;
      break;
    } else {
      console.warn(`[llm] Candidate model ${candidate} probe failed: ${testRes.simpleReason}`);
    }
  }

  if (!workingModel) {
    for (const candidate of candidates) {
      const testRes = await testGeminiModel(candidate, apiKey, true);
      if (testRes.ok) {
        workingModel = candidate;
        break;
      }
    }
  }

  if (!workingModel) {
    console.error('[llm] All Gemini candidate models failed limit check.');
    return { model: currentModel, newModel: currentModel, switched: false };
  }

  const simpleMsg = `Switched model to ${workingModel}: ${currentModel} ${detectedReason}.`;
  console.log(`[llm] ${simpleMsg}`);

  try {
    db.prepare("UPDATE llm_providers SET model = ? WHERE kind = 'gemini'").run(workingModel);
  } catch (e) {
    console.error('[llm] Failed to update llm_providers model:', e);
  }

  invalidateProviderCache();
  addSystemNotification('model_switch', simpleMsg);

  return { model: workingModel, newModel: workingModel, switched: true, message: simpleMsg };
}

/**
 * Pre-flight test for Gemini model before starting any major process.
 * If the current model exceeds its limit or is unhealthy, dynamically switches to a working model.
 */
export async function ensureWorkingGeminiModel(forceCheck = false): Promise<{ model: string; switched: boolean; message?: string }> {
  let key: string | null = null;
  let currentModel = 'gemini-3.8-flash';

  try {
    const row = db
      .prepare("SELECT model, api_key FROM llm_providers WHERE kind = 'gemini' AND api_key IS NOT NULL ORDER BY is_active DESC LIMIT 1")
      .get() as { model: string; api_key: string } | undefined;
    if (row) {
      currentModel = row.model || currentModel;
      key = row.api_key;
    }
  } catch { /* DB might be initializing */ }

  if (!key) key = process.env.GEMINI_API_KEY || null;
  if (!key) {
    return { model: currentModel, switched: false };
  }

  const testRes = await testGeminiModel(currentModel, key, forceCheck);
  if (testRes.ok) {
    return { model: currentModel, switched: false };
  }

  console.warn(`[llm] Gemini model ${currentModel} limit check failed (${testRes.simpleReason}) — dynamically switching model...`);
  return await switchGeminiModel(currentModel, key, testRes.simpleReason);
}

/**
 * Outer ceiling for one provider attempt.
 *
 * This must sit ABOVE whatever timeout the provider enforces itself, or the outer race pre-empts
 * it and turns a still-running call into a spurious failure. Freeway is the case that matters: it
 * scales its timeout with the token budget, so we mirror that formula and add a margin. Everything
 * else has no internal timeout of its own and gets the flat default.
 */
function ceilingFor(cfg: { kind: string }, maxTokens?: number, override?: number): number {
  // An explicit ceiling always wins — it is how an interactive caller says "I cannot wait that
  // long", and it must cap the budget-scaled Freeway value rather than be capped by it.
  if (override) return override;
  if (cfg.kind === 'freeway' && maxTokens) {
    // +30s so the gateway's own timeout always fires first and reports a real reason.
    return freewayTimeoutFor(maxTokens) + 30_000;
  }
  return LLM_CALL_TIMEOUT_MS;
}

// Run `run` against each provider in the chain until one succeeds. Quota failures cool the
// offending provider down; any failure logs and rotates to the next. Throws the last error
// only if every provider fails.
async function callWithProviders<T>(
  run: (cfg: ProviderConfig) => Promise<T>,
  /**
   * Token budget for this call, when the caller knows it.
   *
   * Needed because the ceiling is NOT one number for all providers: Freeway scales its own timeout
   * with the budget (60ms/token — a 4096-token structured evaluation gets ~246s), and a flat 120s
   * outer race would fire first, mark Freeway failed, and fall through to paid Gemini for exactly
   * the slow calls Freeway exists to absorb.
   */
  maxTokens?: number,
  /** Hard ceiling per attempt, for callers a human is waiting on. */
  timeoutMs?: number,
  /** Provider kinds to leave out — used to skip a provider already known to fail for this lane. */
  skipKinds?: ReadonlySet<string>,
): Promise<T> {
  const chain = buildProviderChain().filter((c) => !skipKinds?.has(c.kind));
  let lastErr: unknown;
  for (const cfg of chain) {
    try {
      if (cfg.kind === 'gemini') {
        const check = await ensureWorkingGeminiModel();
        if (check.switched) {
          cfg.model = check.model;
        }
      }
      const r = await withLlmTimeout(run(cfg), `${cfg.kind} (${cfg.model})`, ceilingFor(cfg, maxTokens, timeoutMs));
      lastUsedProviderKind = cfg.kind;
      recordLLMUsage(cfg.kind, cfg.model, maxTokens || 200, cfg.id);
      return r;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Freeway can't do long-form prose in a window a human will wait through — it either
      // truncates mid-reasoning or simply doesn't finish. Both are the same lesson, and both cost
      // ~75s to learn, so record either one. NOT a provider cooldown: Freeway is fine for
      // structured work (it served 29 job evaluations) — this is lane-specific.
      if (cfg.kind === 'freeway' && /token cap before finishing|incomplete reasoning|did not respond in time|timed out/i.test(msg)) {
        globalForCreative.__hsFreewayNoCreative = true;
      }
      if (isQuotaError(msg) || isModelGoneError(msg)) markCooldown(cfg.id, msg);
      console.warn(`[llm] ${cfg.kind} failed (${msg.slice(0, 100)}) — trying next`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All providers failed');
}

// Structured (JSON) generation across any provider kind, returning RAW text (caller extracts
// the JSON object). Clients are built per-call from `cfg` so each provider in the chain uses its
// own key/model. Mirrors the native structured-output paths used elsewhere in this file.
async function runStructured(
  cfg: ProviderConfig,
  prompt: string,
  geminiSchema: Schema,
  anthropicSchema: Record<string, unknown>,
  maxTokens = 4096,
): Promise<string> {
  let text: string | null | undefined;
  switch (cfg.kind) {
    case 'gemini': {
      if (!cfg.apiKey) throw new Error('Gemini provider missing api_key');
      const check = await ensureWorkingGeminiModel();
      let targetModel = check.switched ? check.model : (cfg.model || 'gemini-3.8-flash');
      const client = new GoogleGenerativeAI(cfg.apiKey);
      const makeModel = (m: string) =>
        client.getGenerativeModel({
          model: m,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: geminiSchema,
            maxOutputTokens: Math.max(maxTokens, 8192),
          },
        });
      let result;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await makeModel(targetModel).generateContent(prompt);
          break;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isQuotaError(msg) || /503|high demand|overloaded/i.test(msg)) {
            const reason = /503|high demand/i.test(msg) ? 'is experiencing high demand' : 'reached quota limit';
            const switched = await switchGeminiModel(targetModel, cfg.apiKey, reason);
            if (switched.switched) {
              targetModel = switched.newModel;
              console.log(`[runStructured] Auto-switched to ${targetModel}. Retrying structured call...`);
              continue;
            }
          }
          if (/503|high demand|temporar|429|Service Unavailable|overloaded/i.test(msg) && attempt < 3) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw err;
        }
      }
      if (!result) throw new Error(`Gemini ${targetModel} structured call failed`);
      text = result.response.text();
      break;
    }
    case 'anthropic': {
      if (!cfg.apiKey) throw new Error('Anthropic provider missing api_key');
      const response = await new Anthropic({ apiKey: cfg.apiKey }).messages.create({
        model: cfg.model,
        max_tokens: maxTokens,
        output_config: { format: { type: 'json_schema', schema: anthropicSchema } },
        messages: [{ role: 'user', content: prompt }],
      });
      const block = response.content.find((b) => b.type === 'text');
      text = block && block.type === 'text' ? block.text : '';
      break;
    }
    case 'openai':
    case 'openai-compatible': {
      text = await openAiChat(cfg, `${prompt}\n\nReturn ONLY valid JSON matching the schema.`, {
        maxTokens,
        jsonSchema: anthropicSchema,
      });
      break;
    }
    case 'freeway': {
      // Freeway never forwards response_format / output_config to the upstream provider, so
      // there is no native structured-output path here — coach the schema in the prompt and let
      // the caller regex-extract the object (same as the Freeway path).
      text = await freewayAsk(
        `${prompt}${schemaToShapeHint(anthropicSchema)}\n\nReturn ONLY a JSON object, no markdown fences, no commentary.`,
        { maxTokens, model: cfg.model, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, label: 'structured' },
      );
      break;
    }
    case 'ollama':
      throw new Error('Ollama is no longer supported. Please configure a Gemini API key in Settings.');
  }
  if (!text || !text.trim()) throw new Error(`${cfg.kind} returned empty structured text`);
  return text;
}

// ---------------------------------------------------------------------------
// OpenAI / OpenAI-compatible handlers (Groq, Cerebras, Mistral, Together, ...)
// All share the OpenAI Chat Completions wire format.
// ---------------------------------------------------------------------------

// Render a JSON schema as a TypeScript-ish shape string the model can copy.
// Used to coach json_object mode (most openai-compatible servers don't support strict json_schema).
function schemaToShapeHint(schema: Record<string, unknown> | undefined): string {
  if (!schema) return '';
  try {
    const required = (schema.required as string[]) || [];
    return `\n\nThe JSON object MUST include ALL of these fields (do not omit any): ${required.join(', ')}.\n\nSchema:\n${JSON.stringify(schema, null, 2)}`;
  } catch {
    return '';
  }
}

async function openAiChat(
  cfg: ProviderConfig,
  prompt: string,
  options: { maxTokens?: number; jsonSchema?: Record<string, unknown>; jsonObjectMode?: boolean } = {}
): Promise<string> {
  const baseUrl = cfg.baseUrl || (cfg.kind === 'openai' ? 'https://api.openai.com/v1' : null);
  if (!baseUrl) throw new Error('OpenAI-compatible provider requires base_url');
  if (!cfg.apiKey) throw new Error('OpenAI-compatible provider requires api_key');

  // For openai-compatible (Groq, Cerebras, Mistral, ...) we skip the strict json_schema path
  // entirely — most servers reject it with 400. Instead, use json_object mode and embed the
  // schema in the prompt so the model fills every required field. Native OpenAI keeps strict.
  const wantStructured = !!options.jsonSchema;
  const useStrictSchema = wantStructured && cfg.kind === 'openai';
  const useJsonObject = wantStructured && cfg.kind !== 'openai';

  const responseFormat = useStrictSchema
    ? { type: 'json_schema' as const, json_schema: { name: 'output', strict: true, schema: options.jsonSchema! } }
    : useJsonObject || options.jsonObjectMode
    ? { type: 'json_object' as const }
    : undefined;

  const enrichedPrompt = useJsonObject
    ? `${prompt}${schemaToShapeHint(options.jsonSchema)}`
    : prompt;

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'user', content: enrichedPrompt }],
    max_tokens: options.maxTokens ?? 4096,
  };
  if (responseFormat) body.response_format = responseFormat;

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    // Without a signal this fetch can hang indefinitely and pin the calling API route.
    signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Strict schema rejected by server — retry as plain json_object
    if (useStrictSchema && res.status === 400) {
      return openAiChat(cfg, prompt, { maxTokens: options.maxTokens, jsonObjectMode: true, jsonSchema: options.jsonSchema });
    }
    const text = await res.text();
    throw new Error(`${cfg.kind} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${cfg.kind} returned no content`);
  recordLLMUsage(cfg.kind, cfg.model, options.maxTokens ?? 4096, cfg.id);
  return text;
}

export type CareerTargets = {
  roles?: string[];          // ["Solution Architect", "Senior Engineer"]
  locations?: string[];      // ["Remote", "India", "Global remote"]
  comp_min?: number;         // numeric annual compensation lower bound
  comp_max?: number;         // numeric annual compensation upper bound
  comp_currency?: string;    // "USD" | "INR" | "EUR" | ...
  must_haves?: string;       // freeform: "Healthcare-IT, FHIR, India-friendly"
  deal_breakers?: string;    // freeform: "On-site only, defense contractors"
};

export type ParsedResume = {
  skills: string[];
  experience: string[];
  education: string[];
  location?: string;
  seniority?: string;
  title?: string;
  yearsOfExperience?: number;
  // Contact details extracted from resume (editable on /profile)
  name?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  // Career targets — explicit "North Star" set by the user on /profile.
  // Fed into evaluation, cover letter, and resume-variant prompts.
  targets?: CareerTargets;
};



// Direct Gemini call for the creative lane — independent of active primary.
// Tries Pro first (best quality), falls back to Flash on quota / 429 errors.
// Many free-tier accounts have limit:0 for Pro — this fallback ensures the lane
// stays useful for those users without manual config.
/**
 * Set once Pro answers with a permanent "not available for this key" error, so the creative lane
 * stops paying for a failed round-trip on every subsequent call. Process-lifetime only —
 * a restart re-probes, which is the right behaviour if the key's entitlements change.
 */
let creativeProUnavailable = false;

/**
 * Set once a CREATIVE call through Freeway comes back truncated mid-reasoning.
 *
 * Freeway is genuinely good for structured work — it served 29 job evaluations — so cooling the
 * PROVIDER ROW down would be wrong; this is lane-specific. But its default model is a reasoning
 * model, and for long-form prose it spends the whole 4096-token budget thinking and returns nothing
 * usable. Once that has happened, every later creative call pays ~70s to learn the same thing:
 * measured a 142s cover letter that was Gemini(2s) + Freeway(70s, doomed).
 * Remembering it drops the same request to ~75s.
 *
 * Process-lifetime only — a restart re-probes, which is right if the gateway's routing changes.
 */
// Hung off globalThis for the same reason `db` and the match memo are: `next dev` re-evaluates
// server modules on demand, which would reset this on the very next request and re-learn the same
// 75s lesson every time.
const globalForCreative = globalThis as unknown as { __hsFreewayNoCreative?: boolean };
function freewayUnusableForCreative(): boolean {
  return globalForCreative.__hsFreewayNoCreative === true;
}

async function creativeGeminiGenerate(prompt: string, maxTokens = 4096): Promise<string> {
  const check = await ensureWorkingGeminiModel();
  let activeModel = check.model;
  const client = getCreativeGeminiClient();
  if (!client) throw new Error('No Gemini API key available for creative lane');
  const budget = Math.min(maxTokens || 4096, 4096);

  const callModel = async (modelName: string) => {
    const model = client.getGenerativeModel({
      model: modelName,
      generationConfig: { maxOutputTokens: budget },
    });
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (!text) {
          const finish = result.response.candidates?.[0]?.finishReason;
          throw new Error(`Gemini ${modelName} returned empty text (finishReason=${finish})`);
        }
        recordLLMUsage('gemini', modelName, budget);
        return text;
      } catch (err: unknown) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (isQuotaError(msg) || /503|high demand|overloaded/i.test(msg)) {
          // Break immediately to switch model instead of wasting retry delays on a rate-limited model
          break;
        }
        if (/temporar|Service Unavailable|fetch/i.test(msg) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          throw err;
        }
      }
    }
    throw lastErr;
  };

  try {
    return await callModel(activeModel);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isQuotaError(msg) || /503|high demand|overloaded/i.test(msg)) {
      let key: string | null = null;
      try {
        const row = db.prepare("SELECT api_key FROM llm_providers WHERE kind = 'gemini' AND api_key IS NOT NULL LIMIT 1").get() as { api_key: string } | undefined;
        if (row?.api_key) key = row.api_key;
      } catch { /* DB */ }
      if (!key) key = process.env.GEMINI_API_KEY || null;

      if (key) {
        const reason = /503|high demand/i.test(msg) ? 'is experiencing high demand' : 'reached quota limit';
        const switched = await switchGeminiModel(activeModel, key, reason);
        if (switched.switched) {
          console.log(`[creative] Retrying creative generation with switched model ${switched.newModel}...`);
          return await callModel(switched.newModel);
        }
      }
    }
    throw e;
  }
}

// Generation lane:
//   'standard' — default, uses the active provider's configured model. Used for fast/structured calls.
//   'creative' — Gemini 2.5 Pro → Flash → active-provider fallback chain. Used for cover-letter /
//                resume-variant where prose quality matters. Independent of active primary so
//                users can keep e.g. Groq active for fast structured calls.
type Lane = 'standard' | 'creative';

// Call a specific provider config directly (used for the user-flagged creative provider).
async function callProviderConfig(
  cfg: CreativeProviderRow,
  prompt: string,
  maxTokens: number,
  /** Also shortens the PROVIDER's own timeout, so the upstream request stops too — an outer race
   *  alone frees the caller while leaving the real request running. */
  timeoutMs?: number,
): Promise<string> {
  switch (cfg.kind) {
    case 'gemini': {
      if (!cfg.api_key) throw new Error('Gemini provider missing api_key');
      const check = await ensureWorkingGeminiModel();
      let modelName = check.switched ? check.model : (cfg.model || 'gemini-3.8-flash');
      const client = new GoogleGenerativeAI(cfg.api_key);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const model = client.getGenerativeModel({
            model: modelName,
            generationConfig: { maxOutputTokens: Math.min(maxTokens || 4096, 4096) },
          });
          const result = await model.generateContent(prompt);
          const text = result.response.text();
          if (!text) throw new Error(`Gemini ${modelName} returned empty text`);
          recordLLMUsage(cfg.kind, modelName, Math.min(maxTokens || 4096, 4096));
          return text;
        } catch (err: unknown) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (isQuotaError(msg) || /503|high demand|overloaded/i.test(msg)) {
            const reason = /503|high demand/i.test(msg) ? 'is experiencing high demand' : 'reached quota limit';
            const switched = await switchGeminiModel(modelName, cfg.api_key, reason);
            if (switched.switched) {
              modelName = switched.newModel;
              console.log(`[llm] Auto-switched to ${modelName} during generation. Retrying immediately...`);
              continue;
            }
          }
          if (/503|high demand|temporar|429|Service Unavailable|overloaded|fetch/i.test(msg) && attempt < 3) {
            const delayMatch = msg.match(/retry(?:Delay)?[\s":]+(\d+(?:\.\d+)?)\s*s/i) || msg.match(/retry in (\d+(?:\.\d+)?)/i);
            const delaySec = delayMatch ? Math.min(Math.ceil(parseFloat(delayMatch[1])) + 1, 10) : attempt * 2;
            console.warn(`[llm] Gemini ${modelName} 503/429 (attempt ${attempt}/3) — retrying in ${delaySec}s...`);
            await new Promise((r) => setTimeout(r, delaySec * 1000));
          } else {
            throw err;
          }
        }
      }
      throw lastErr;
    }
    case 'anthropic': {
      if (!cfg.api_key) throw new Error('Anthropic creative provider missing api_key');
      const client = new Anthropic({ apiKey: cfg.api_key });
      const response = await client.messages.create({
        model: cfg.model || 'claude-sonnet-4-5',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = response.content.find((b) => b.type === 'text');
      if (!block || block.type !== 'text') throw new Error('Anthropic returned no text block');
      recordLLMUsage(cfg.kind, cfg.model || 'claude-3-5-haiku-20241022', maxTokens);
      return block.text;
    }
    case 'openai':
    case 'openai-compatible':
      return openAiChat(
        { kind: cfg.kind, model: cfg.model, apiKey: cfg.api_key, baseUrl: cfg.base_url, source: 'db' },
        prompt,
        { maxTokens },
      );
    case 'freeway':
      return freewayAsk(prompt, {
        maxTokens,
        model: cfg.model,
        apiKey: cfg.api_key,
        baseUrl: cfg.base_url,
        label: 'generate',
        timeoutMs,
      });
    case 'ollama':
      throw new Error('Ollama is no longer supported. Please configure a Gemini API key in Settings.');
    default:
      throw new Error(`Unsupported creative provider kind: ${cfg.kind}`);
  }
}

export async function primaryGenerate(
  prompt: string,
  maxTokens = 2048,
  lane: Lane = 'standard',
  /** `timeoutMs` caps EVERY provider attempt — pass LLM_INTERACTIVE_TIMEOUT_MS when a user waits. */
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  // Pre-flight test Gemini model to ensure it is healthy before proceeding
  try {
    await ensureWorkingGeminiModel();
  } catch { /* best-effort pre-flight */ }

  if (lane === 'creative') {
    // 1. User-flagged creative provider in DB (opt-in)
    const flagged = getCreativeProvider();
    if (flagged) {
      try {
        // Bounded like the chain attempts — the creative lane bypasses callWithProviders, so
        // without this a hung flagged provider pins the route with no failover.
        return await withLlmTimeout(
          callProviderConfig(flagged, prompt, maxTokens),
          `creative ${flagged.kind}`,
          opts.timeoutMs,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[creative] flagged provider (${flagged.kind} ${flagged.model}) failed: ${msg.slice(0, 140)}…`);
        // Fall through to Gemini path
      }
    }
    // 2. Gemini Pro → Flash (default creative path when a Gemini key exists)
    if (getCreativeGeminiClient()) {
      try {
        return await withLlmTimeout(creativeGeminiGenerate(prompt, maxTokens), 'creative gemini', opts.timeoutMs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[creative] Gemini lane failed (${msg.slice(0, 140)}…) — falling back to active provider`);
      }
    }
    // 3. Fall through to the provider chain (active → other keys → Freeway)
  }
  return callWithProviders(
    (cfg) =>
      callProviderConfig(
        { kind: cfg.kind, model: cfg.model, api_key: cfg.apiKey, base_url: cfg.baseUrl },
        prompt,
        maxTokens,
        opts.timeoutMs,
      ),
    maxTokens,
    opts.timeoutMs,
    // Creative prose through Freeway's reasoning model truncates; once seen, don't pay for it again.
    lane === 'creative' && freewayUnusableForCreative() ? new Set(['freeway']) : undefined,
  );
}

// Banned phrases — recruiter-cliché vocabulary that signals AI-generated or generic text.
const BANNED_PHRASES = `passionate about, leveraged, spearheaded, synergy, dynamic, results-driven, hit the ground running, wear many hats, go-getter, team player, detail-oriented, self-starter, thought leader, value-add, deep dive, low-hanging fruit, move the needle, circle back, ecosystem, paradigm, cutting-edge, world-class, best-in-class, robust, scalable solutions, end-to-end, holistic, strategic, innovative solutions, proven track record, fast-paced environment, mission-critical`;

const COVER_LETTER_RULES = `You are a professional cover letter writer. Write a cover letter for this job.

IMPORTANT RULES:
- ONLY reference skills explicitly present in the resume below
- Never invent experience or skills
- Acknowledge gaps honestly if relevant
- Professional but personable tone — write like a senior engineer talking to another engineer, not like a recruiter
- Use the candidate's ACTUAL name, email, phone, and LinkedIn from the resume header — never use placeholder text like [Your Name], [Your Email], or [Your Phone]. If a field is missing, omit that line entirely.
- Output as Markdown with clean, distinct section blocks separated by blank lines:
  1. Candidate header: Name, email, phone, LinkedIn URL (each separated so they render cleanly without collapsing).
  2. Date (e.g., September 17, 2026).
  3. Recipient: [Company Name] Hiring Team.
  4. Salutation: Dear Hiring Manager,
  5. 3-4 body paragraphs separated by blank lines.
  6. Closing: Sincerely,
  7. Candidate Name.

LENGTH & ATS RULES:
- HARD CAP: 350 words for the body (header + closing don't count). A recruiter reads in 30 seconds.
- 3-4 body paragraphs. Don't pad.
- Plain ASCII only (no smart quotes, em-dashes, ellipses) — ATS parsers fail on these.
- No tables, no images, no bullet lists in the body — only prose paragraphs. (Bullet lists belong in the resume, not the cover letter.)

WRITING STANDARDS:
- Prefer specifics over abstractions — "cut p99 latency from 800ms to 120ms" beats "improved performance"
- Vary sentence structure; mix short punchy sentences with longer ones
- BANNED PHRASES — do not use any of these or close paraphrases: ${BANNED_PHRASES}
- Avoid filler ("I am writing to express", "It would be a privilege to") — open with substance
- One concrete proof point per paragraph minimum (a number, a system, a named project)`;

const RESUME_VARIANT_RULES = `You are an elite, highly targeted resume tailoring engine. Rewrite the candidate's resume tailored to the target role. Output **valid Markdown** that renders as a clean professional resume and achieves a high ATS match score.

YOUR GOAL:
Achieve a 95%+ to 99% ATS match score by dynamically aligning the candidate's profile summary, skills, work experience, and project details with the target Job Description's required tech stack, keywords, and responsibilities.

CRITICAL INSTRUCTIONS:
1. STRICT FACTUAL ACCURACY & CANDIDATE DATA FIDELITY:
   - Use ONLY the facts, employment history, company names, job titles, dates, education, and real achievements provided in the candidate's ORIGINAL RESUME (facts).
   - DO NOT invent fake companies, fake job titles, fake degrees, fake locations, or hallucinated experience.
   - Emphasize and reframe the candidate's real experiences and achievements to best align with the target job description.

2. DYNAMIC SKILL CATEGORIZATION & ATS KEYWORD ALIGNMENT IN ## Skills:
   - Categorize the candidate's technical and professional skills into clean lines (e.g., **Core Skills:**, **Tools & Technologies:**, **Frameworks & Databases:**).
   - Ensure target job description keywords that match the candidate's capabilities are highlighted in ## Skills so ATS keyword scanners rate the resume at 95%+.

3. WORK EXPERIENCE (## Experience):
   - Under the candidate's current/latest organization (and recent employment history), modify the content by ADDING NEW BULLET LINES based on the target Job Description's tech stack, keywords, and domain requirements.
   - All newly added experience bullet lines MUST match and align with the candidate's current organization domain (as derived from their existing work experience and project details).
   - Keep the candidate's real employer names, role titles, employment dates, and original core achievements intact.

4. PROJECTS SECTION (## Projects):
   - DO NOT MODIFY EXISTING PROJECTS! Leave all of the candidate's existing projects completely intact as they are.
   - For every new job application, ADD ONE OR TWO NEW PROJECTS tailored specifically to the target Job Description's required technologies and methodologies.
   - The newly added projects MUST match the candidate's current working domain and technical capabilities.

5. ATS-SAFE FORMATTING:
   - Use proper Markdown sections in this order: # Name (heading), contact line under it, ## Summary, ## Skills, ## Experience, ## Projects (if present), ## Education.
   - Plain ASCII only (no tables, no multi-column layouts, no emoji).
   - Do NOT wrap in code fences, output only the Markdown content.`;

export interface KeywordCoverage {
  required: string[];   // top JD keywords we asked the model to mirror
  matched: string[];    // those that landed in the output
  missing: string[];    // those that didn't
}

export interface CoverLetterResult {
  text: string;
  coverage: KeywordCoverage;
}

// Templates for the LaTeX résumé lane — tailored resumes that keep the user's Overleaf design
// (same \documentclass, preamble, packages and section macros) instead of the Markdown fallback.
const RESUME_LATEX_RULES = `You are an elite, highly targeted LaTeX resume tailoring engine. Given the candidate's profile and their LaTeX template, produce a surgically tailored, high-scoring ATS resume for the target job role.

YOUR GOAL:
Achieve a 95%+ to 99% ATS match score by carefully reading the target Job Description, identifying all required skills, title keywords, domain concepts, tools, and responsibilities, and dynamically aligning the candidate's profile summary, skills section, work experience bullets, and project details with maximum ATS keyword density.

CRITICAL SECTION-BY-SECTION INSTRUCTIONS:

1. PRESERVE THE CANDIDATE'S LATEX TEMPLATE DESIGN & FONT SIZE:
   - The output must be a COMPLETE, self-contained, compilable .tex document (from \\documentclass to \\end{document}).
   - Preserve the exact LaTeX commands, preamble, geometry, packages, font size (do NOT alter \\documentclass font size option), and custom macros (e.g. \\resumeSubheading, \\resumeProjectHeading, \\resumeItem, \\resumeItemListStart, \\resumeItemListEnd). Do not invent new macros or alter layout geometry.

1b. PRESERVE PARACOL / TWO-COLUMN LAYOUT & COLUMN SWITCHES:
   - If the template uses \\begin{paracol}{2} and \\switchcolumn, you MUST preserve \\begin{paracol}{2}, \\switchcolumn, and \\end{paracol} intact.
   - DO NOT remove \\switchcolumn or convert a 2-column template into single-column stream.
   - All tabularx environments inside \\begin{paracol} MUST use \\linewidth (NOT \\textwidth) so tables fit within the paracol column.

2. DYNAMIC CANDIDATE DATA FIDELITY (NO FAKE COMPANIES / SKILLS):
   - Use ONLY the facts from the candidate's PARSED RESUME (facts) — candidate's real name, contact info, real employers, real job titles, real dates, real locations, real projects, and real degree.
   - DO NOT insert hardcoded fake companies, fake locations, or fake tech stacks not present in the candidate's background.

2b. PRESERVE THE HEADING BLOCK VERBATIM (CRITICAL):
   - The candidate's NAME and PROFILE TITLE/HEADLINE (the \\large or \\Large line below their name in \\begin{center}...\\end{center}) MUST be copied EXACTLY from the template — character for character.
   - DO NOT change "Business Analyst" to "Data Engineer" or any other role in the top header.
   - Only the body sections (\\section{Summary}, \\section{Skills}, \\section{Experience}, \\section{Projects}) may be tailored.

3. HIGH-IMPACT TARGET-ALIGNED SUMMARY (\\section{Summary}):
   - Rewrite \\section{Summary} body text to open with a compelling professional summary that explicitly incorporates the target job's title domain, core responsibilities, key methodologies, and required skills (e.g. Risk Assessment, UAT, Business Requirements, Internal Controls, AI/LLM, Process Automation).
   - Keep their actual professional title (e.g., "Business Analyst") — describe how their background is directly aligned to the target role's deliverables.
   - YEARS OF EXPERIENCE FORMATTING: Always format experience in the Summary as "3+ years" (or "N+ years", e.g. "3+ years of experience").

4. MANDATORY HIGH-DENSITY ATS KEYWORD & SKILL ALIGNMENT (\\section{Skills}):
   - Every single keyword under REQUIRED ATS KEYWORDS and key skills from the Job Description MUST appear explicitly in \\section{Skills} under clean, professional category headers appropriate to candidate background (e.g., Domain \\& Business Analysis, Methodologies \\& Testing, Tools \\& Technologies, AI \\& Analytics).
   - Never omit required target skills or title skills — this is critical for passing ATS thresholding (>90%+ match).

5. WORK EXPERIENCE (\\section{Experience}):
   - The candidate's original employers, role titles, dates, locations, and core achievements MUST remain intact.
   - Under the candidate's current/latest organization, modify the content by ADDING NEW BULLET LINES (\\resumeItem{...}) tailored to the target Job Description's tech stack, keywords, and domain requirements.
   - All newly added experience lines MUST strictly match the candidate's current organization domain (derived from existing work experience and project details).

6. PROJECTS (\\section{Projects}):
   - DO NOT MODIFY EXISTING PROJECTS! Leave all original projects from the candidate's LaTeX template completely unchanged.
   - For the new job application, ADD ONE OR TWO NEW PROJECTS (using \\resumeProjectHeading and \\resumeItem) tailored specifically to the target Job Description.
   - The newly added project(s) MUST match the candidate's current working domain and technical background.

7. COMPILATION SAFETY:
   - Clean ASCII / standard LaTeX only: escape %, &, _, # properly (e.g. \\%, \\&, \\_, \\#).
   - Output ONLY the raw compilable .tex code. No markdown fences, no explanatory text.

8. STRICT WORD & SENTENCE BUDGET (NO FONT RESIZING):
   - DO NOT change the font size or \\documentclass options.
   - Keep each bullet concise (maximum 12 to 18 words per bullet) so that the tailored resume fits neatly.`;

export interface ResumeLatexResult {
  text: string;
  coverage: KeywordCoverage;
}

export async function generateLatexResume(
  resumeJson: object,
  resumeTex: string,
  jobTitle: string,
  company: string,
  jobDescription: string,
  /** Pass `{ interactive: true }` when a user is waiting — see LLM_INTERACTIVE_TIMEOUT_MS. */
  opts: { interactive?: boolean; fixHint?: string } = {},
): Promise<ResumeLatexResult> {
  const keywords = extractJdKeywords(jobDescription, jobTitle, 25);
  const requiredList = keywords.map((k) => k.term);
  const keywordsBlock = requiredList.length
    ? `\n\nREQUIRED ATS KEYWORDS (Ensure all these terms appear verbatim in \\section{Skills} and are seamlessly incorporated into experience / project bullets to achieve 99% ATS match):\n${requiredList.join(', ')}\n`
    : '';
  const fixBlock = opts.fixHint
    ? `\n\nA PREVIOUS VERSION OF YOUR OUTPUT FAILED TO COMPILE with the following engine error. Keep ALL content and design, but repair the STRUCTURE (balanced braces/environments, macros called with the correct arguments, all \\resumeProjectHeading-like macros given every argument they expect — e.g. an empty {date} group must still be present, every \\begin{X} matched by \\end{X}, no stray $ or }):\n---\n${opts.fixHint.slice(0, 1500)}\n---\nRespond with the FULL corrected .tex document again.\n`
    : '';
  let targetPages = 1;
  try {
    const { getLatexPageCount } = await import('./apply/latex');
    const cnt = await getLatexPageCount(resumeTex, 15_000);
    if (cnt > 0) targetPages = cnt;
  } catch {
    // fallback to 1 page if template page count probe fails
  }

  const bulletCount = (resumeTex.match(/\\(?:resumeItem|item)\b/g) || []).length;
  const budgetBlock = bulletCount > 0
    ? `\nCRITICAL PAGE BUDGET & SECTION INTEGRITY CONSTRAINT:
- The candidate's template spans EXACTLY ${targetPages} page(s).
- DO NOT modify or remove any existing projects — leave all existing projects completely intact.
- Under current organization, modify work experience by adding new bullet lines tailored to the target JD (matching current organization domain).
- Add 1 or 2 new projects tailored to the job description (matching current working domain).
- Keep each bullet point concise (maximum 12 to 18 words per bullet) so the entire document fits on target page(s) without reducing font size.\n`
    : '';

  const prompt = `${RESUME_LATEX_RULES}
${fixBlock}
${keywordsBlock}
${budgetBlock}
PARSED RESUME (facts):
${JSON.stringify(resumeJson, null, 2)}

TARGET JOB TITLE: ${jobTitle}
TARGET COMPANY: ${company}

JOB DESCRIPTION:
${jobDescription.slice(0, 4000)}

CANDIDATE'S LATEX TEMPLATE (edit its CONTENT, keep its design):
---
${resumeTex.slice(0, 20000)}
---

Write the tailored .tex now:`;

  let text: string;
  try {
    text = await primaryGenerate(prompt, 4096, 'creative', {
      timeoutMs: opts.interactive ? Math.max(LLM_INTERACTIVE_TIMEOUT_MS, 90_000) : undefined,
    });
  } catch (e) {
    if (!opts.interactive) throw e;
    const why = e instanceof Error ? e.message.slice(0, 120) : String(e);
    console.warn(`[creative] cloud providers unavailable (${why}) — LaTeX résumé generation failed`);
    throw e; // No local fallback — Gemini is required for LaTeX résumé generation
  }
  const { matched, missing } = matchKeywordsInText(text, keywords);
  // Never trust the model to reproduce the user's preamble/design byte-for-byte — splice its NEW
  // content into the original template's body instead, and strip any non-ASCII that would break
  // pdflatex. A weak local model WILL otherwise emit unbalanced braces / UTF-8 in the output.
  const splice = await import('./apply/latex');
  const repaired = splice.spliceLatexContent(resumeTex, text);
  return { text: repaired, coverage: { required: requiredList, matched, missing } };
}


export async function generateCoverLetter(
  resumeJson: object,
  jobTitle: string,
  company: string,
  jobDescription: string,
  /** Pass `{ interactive: true }` when a user is watching a spinner — see LLM_INTERACTIVE_TIMEOUT_MS. */
  opts: { interactive?: boolean } = {},
): Promise<CoverLetterResult> {
  // Extract top JD-keywords (mostly hard tech/ontology terms — natural to mention in prose).
  // Cover letters can't cram in every keyword, so we use a smaller list than for resumes.
  const keywords = extractJdKeywords(jobDescription, jobTitle, 8);
  const requiredList = keywords.map((k) => k.term);
  const keywordsBlock = requiredList.length
    ? `\n\nKEYWORDS TO MIRROR (use these exact terms naturally where the candidate has matching experience — do NOT force ones the candidate lacks):\n${requiredList.join(', ')}\n`
    : '';

  // resumeJson typically includes a `targets` object describing the candidate's
  // career goals (target roles, locations, comp range, must-haves, deal-breakers).
  // The cover letter should reflect alignment between targets and this specific role.
  const prompt = `${COVER_LETTER_RULES}

RESUME (note: 'targets' shows what THIS candidate is looking for — use it to tailor the angle, e.g. emphasize growth fit if 'must_haves' lists growth):
${JSON.stringify(resumeJson, null, 2)}

JOB TITLE: ${jobTitle}
COMPANY: ${company}

JOB DESCRIPTION:
${jobDescription.slice(0, 3000)}${keywordsBlock}
Write the cover letter now:`;

  // 4096, not 2048. The creative lane can land on Freeway, whose default model is a REASONING
  // model that bills its thinking against the same budget (the same reason `MIN_MAX_TOKENS` exists
  // in freeway.ts). Measured on a real call: with 2048 the model spent the whole budget thinking
  // and returned its scratchpad — "We need to write a cover letter for X at Y. Use resume detai…" —
  // truncated at stop=max_tokens. A letter is ~700 tokens; the rest is headroom for the reasoning.
  let text: string;
  try {
    text = await primaryGenerate(prompt, 4096, 'creative', {
      timeoutMs: opts.interactive ? LLM_INTERACTIVE_TIMEOUT_MS : undefined,
    });
  } catch (e) {
    if (!opts.interactive) throw e;
    const why = e instanceof Error ? e.message.slice(0, 120) : String(e);
    console.warn(`[creative] cover letter generation failed — no local fallback available (${why})`);
    throw e;
  }
  const { matched, missing } = matchKeywordsInText(text, keywords);
  return { text, coverage: { required: requiredList, matched, missing } };
}

const JD_FORMAT_RULES = `You are reformatting a messy job description for a personal job-search dashboard.

INPUT: a job description that may be plain text (HTML tags stripped, structure lost) or already structured.
OUTPUT: clean Markdown that preserves ALL factual content but adds proper structure.

Rules:
- Preserve every responsibility, requirement, qualification, benefit, salary number, location detail, and tech stack item. DO NOT summarize, paraphrase, or omit.
- Use these section headings when the content fits, in this order: ## About the role, ## Responsibilities, ## Requirements, ## Nice to have, ## Benefits, ## About the company, ## Compensation, ## Location & remote policy, ## Other.
- Skip a section if there's nothing for it. Don't fabricate sections.
- Convert run-on bullet content into proper "- bullet" lists. One bullet per line.
- Use **bold** for technology names, framework names, salary numbers, and visa/relocation language.
- Use plain ASCII (no smart quotes, em-dashes, fancy bullets) so the formatted JD copies cleanly elsewhere.
- Output only the Markdown body. No code fences, no preamble, no closing remarks.
- If the input is short or already well-formatted, return it as-is with at most light cleanup.`;

export type JobEvaluation = {
  overall_score: number;          // 1.0 - 5.0
  recommendation: 'apply' | 'consider' | 'skip';
  cv_alignment_score: number;     // 1-5: how closely the resume matches what the role needs
  cv_alignment_notes: string;     // 1-3 sentences citing specific resume lines vs JD requirements
  north_star_fit_score: number;   // 1-5: how well the role matches candidate's stated targets
  north_star_fit_notes: string;
  compensation_score: number;     // 1-5; if no comp data in JD, score 3 ("unknown") and note that
  compensation_notes: string;
  culture_score: number;          // 1-5: red flags, async culture, work-life signals
  culture_notes: string;
  strategy_notes: string;         // 1-2 paragraphs: cover letter angle, gaps to address, preparation focus
};

// Coerce a parsed (possibly malformed) model object into a well-formed JobEvaluation.
// JSON output from weak models is far less reliable than Gemini/Anthropic structured output — fields can be
// missing, numbers stringified, or notes returned as arrays/objects. Without this, downstream SQL
// binds throw "SQLite3 can only bind numbers, strings, bigints, buffers, and null" and
// `recommendation.toUpperCase()` crashes the whole rating run when a weak model is used.
function clampScore(x: unknown, fallback = 3): number {
  const n = typeof x === 'string' ? parseFloat(x) : x;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, n));
}
function asText(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('; ');
  if (typeof x === 'object') return JSON.stringify(x);
  return String(x);
}
// A weak model can return JSON that parses but says nothing — no score and no prose. Coercing
// that into "3 / consider" (clampScore's fallback) manufactures an evaluation the model never
// made, and it lands in job_evaluations looking authoritative: the UI shows a score, and the row
// stops the job being re-evaluated. Throwing instead makes it a PROVIDER failure, so
// callWithProviders rotates to the next provider — a missing rating beats an invented one.
// (6 such rows exist in the DB from 2026-07-17/18, written before this guard: 5 ollama, 1 gemini.)
function assertUsableEvaluation(raw: Record<string, unknown>): void {
  const hasScore = Number.isFinite(typeof raw.overall_score === 'string' ? parseFloat(raw.overall_score) : raw.overall_score);
  const prose = [raw.cv_alignment_notes, raw.north_star_fit_notes, raw.compensation_notes, raw.culture_notes, raw.strategy_notes]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .join('');
  // Requires BOTH, deliberately. A score with no reasoning behind it is the exact thing that is
  // worse than no rating — and failing here rotates to the next provider, whereas letting it
  // through only to be refused at the route boundary would surface a 502 to the user while a
  // healthy provider sat unused later in the chain.
  if (!hasScore || !prose) {
    throw new Error(
      `evaluation unusable (score=${hasScore ? 'ok' : 'missing'}, reasoning=${prose ? 'ok' : 'empty'}) — treating as a provider failure`,
    );
  }
}

function coerceEvaluation(raw: Record<string, unknown>): JobEvaluation {
  assertUsableEvaluation(raw);
  const overall = clampScore(raw.overall_score);
  const recRaw = typeof raw.recommendation === 'string' ? raw.recommendation.trim().toLowerCase() : '';
  const recommendation = (['apply', 'consider', 'skip'] as const).includes(recRaw as 'apply')
    ? (recRaw as JobEvaluation['recommendation'])
    : overall >= 4 ? 'apply' : overall >= 3 ? 'consider' : 'skip';
  return {
    overall_score: overall,
    recommendation,
    cv_alignment_score: clampScore(raw.cv_alignment_score),
    cv_alignment_notes: asText(raw.cv_alignment_notes),
    north_star_fit_score: clampScore(raw.north_star_fit_score),
    north_star_fit_notes: asText(raw.north_star_fit_notes),
    compensation_score: clampScore(raw.compensation_score),
    compensation_notes: asText(raw.compensation_notes),
    culture_score: clampScore(raw.culture_score),
    culture_notes: asText(raw.culture_notes),
    strategy_notes: asText(raw.strategy_notes),
  };
}

const EVALUATION_RULES = `You are a hiring evaluator helping a senior candidate decide whether to invest time in applying to a specific role. Score across 4 dimensions on a 1-5 scale where:
  5 = strong match, apply with confidence
  4 = good match, apply
  3 = decent but not ideal, consider
  2 = stretch / unclear fit, probably skip
  1 = clear mismatch, skip

Rules:
- Be honest. Do not hallucinate strengths the candidate doesn't have, and do not minimize gaps.
- Cite specific resume lines or facts when scoring CV alignment.
- For compensation: if the JD doesn't disclose pay, score 3 with a note that comp is undisclosed — do not penalize aggressively.
- For culture: look for red flags (excessive jargon, "rockstar", "family", "fast-paced", layoffs, repeated reposts), and positive signals (clear async culture, stated comp, growth language).
- The "recommendation" field is your overall verdict: 'apply' (overall ≥ 4), 'consider' (3-4), 'skip' (< 3).
- "strategy_notes": 1-2 short paragraphs of practical guidance — cover letter angle, gaps to acknowledge, prep focus. Specific, not generic.
- Notes for each dimension: 1-3 short sentences. Specific evidence > flowery language.
- Output strict JSON matching the schema. No prose outside the JSON.`;

const EVALUATION_SCHEMA_GEMINI: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    overall_score: { type: SchemaType.NUMBER },
    recommendation: { type: SchemaType.STRING, format: 'enum', enum: ['apply', 'consider', 'skip'] },
    cv_alignment_score: { type: SchemaType.NUMBER },
    cv_alignment_notes: { type: SchemaType.STRING },
    north_star_fit_score: { type: SchemaType.NUMBER },
    north_star_fit_notes: { type: SchemaType.STRING },
    compensation_score: { type: SchemaType.NUMBER },
    compensation_notes: { type: SchemaType.STRING },
    culture_score: { type: SchemaType.NUMBER },
    culture_notes: { type: SchemaType.STRING },
    strategy_notes: { type: SchemaType.STRING },
  },
  required: ['overall_score', 'recommendation', 'cv_alignment_score', 'cv_alignment_notes', 'north_star_fit_score', 'north_star_fit_notes', 'compensation_score', 'compensation_notes', 'culture_score', 'culture_notes', 'strategy_notes'],
};

const EVALUATION_SCHEMA_ANTHROPIC = {
  type: 'object' as const,
  properties: {
    overall_score: { type: 'number' as const },
    recommendation: { type: 'string' as const, enum: ['apply', 'consider', 'skip'] },
    cv_alignment_score: { type: 'number' as const },
    cv_alignment_notes: { type: 'string' as const },
    north_star_fit_score: { type: 'number' as const },
    north_star_fit_notes: { type: 'string' as const },
    compensation_score: { type: 'number' as const },
    compensation_notes: { type: 'string' as const },
    culture_score: { type: 'number' as const },
    culture_notes: { type: 'string' as const },
    strategy_notes: { type: 'string' as const },
  },
  required: ['overall_score', 'recommendation', 'cv_alignment_score', 'cv_alignment_notes', 'north_star_fit_score', 'north_star_fit_notes', 'compensation_score', 'compensation_notes', 'culture_score', 'culture_notes', 'strategy_notes'],
  additionalProperties: false,
};

export async function evaluateJob(
  resumeJson: object,
  jobTitle: string,
  company: string,
  jobLocation: string,
  jobDescription: string,
): Promise<JobEvaluation> {
  const prompt = `${EVALUATION_RULES}

CANDIDATE RESUME (note 'targets' shows what the candidate is looking for — North Star alignment scoring uses this):
${JSON.stringify(resumeJson, null, 2)}

JOB:
- Title: ${jobTitle}
- Company: ${company}
- Location: ${jobLocation}
- Description:
${(jobDescription || '').slice(0, 8000)}

Return strict JSON matching the schema. Be specific in notes.`;

  const text = await callWithProviders((cfg) =>
    runStructured(cfg, prompt, EVALUATION_SCHEMA_GEMINI, EVALUATION_SCHEMA_ANTHROPIC, 4096),
    // Pass the budget so a Freeway attempt gets a ceiling above its own scaled timeout.
    4096,
  );
  const m = text.trim().match(/\{[\s\S]*\}/);
  if (!m) throw new Error('evaluateJob: no JSON in model output');
  return coerceEvaluation(JSON.parse(m[0]) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Company research / recession-resilience brief (Sawan-Kapoor-style)
// ---------------------------------------------------------------------------

export type CompanyBrief = {
  // Financial resilience — the primary lens
  financial_health_score: number;          // 1-5
  financial_health_summary: string;
  funding_summary: string;                 // e.g. "Series B, $35M, lead a16z, 2024"
  layoffs_summary: string;                 // e.g. "Cut 8% Mar 2024" or "No layoffs in 24 months" or "Unknown"
  growth_signal: string;                   // headcount trend / hiring velocity
  // Culture & people
  culture_score: number;                   // 1-5
  culture_summary: string;
  positive_themes: string[];               // 2-3 short themes from review aggregation
  concerns: string[];                      // 2-3 short concern themes
  retention_signal: string;                // "median tenure ~3yr" / "high turnover" / "unknown"
  // Compensation
  comp_summary: string;                    // "P50 ~$165k for Solutions Engineer, US Remote (Levels.fyi)"
  // Legitimacy & decision
  legitimacy_score: number;                // 1-5: real company? real role?
  legitimacy_notes: string;
  overall_score: number;                   // 1-5 weighted (financial 40, culture 25, comp 20, legit 15)
  recommendation: 'apply' | 'hold' | 'pass';
  questions_for_recruiter: string[];       // 3-5 targeted questions
  evidence_sources: Array<{ label: string; url: string }>;
};

const COMPANY_BRIEF_RULES = `You are a career research analyst evaluating a company FROM a candidate's perspective. The candidate is deciding whether the company is stable enough to invest application energy in.

PRIMARY LENS — Financial resilience (40% weight):
A great culture is moot if the company lays the candidate off in 6 months. Score on:
- Funding status: latest round, total raised, valuation, lead investors
- Layoff history: rounds in the last 24 months, % cut, departments
- Headcount trend: growing, flat, shrinking
- Industry sector: counter-cyclical (healthcare, defense, infrastructure, regulated) vs cyclical (ad-tech, crypto, real estate, consumer apps)
- For public companies: revenue trend, profitability direction, debt load
Score 5 = very stable (e.g. profitable public co with growing headcount). Score 1 = imminent collapse risk.

SECONDARY LENS — Culture & people (25% weight):
- Top 2-3 positive review themes (compensation transparency, work-life, mission, learning)
- Top 2-3 concerns (toxic management, pay delays, layoffs, unclear strategy, burnout culture)
- Retention signal (median tenure if known)

THIRD LENS — Compensation reality (20% weight):
Market band for this role/location based on Levels.fyi, Glassdoor, Ambitionbox.

FOURTH LENS — Legitimacy (15% weight):
Is this a real company offering real roles? Flag: no public website, no LinkedIn presence, vague generic JD, perpetual reposting (>3 months), pay-to-apply schemes.

HONESTY:
- Do not fabricate funding rounds, headcount, or layoff data. If you don't have recent data, mark the field "Unknown" or "Recent data unavailable".
- For lesser-known companies, give lower-confidence assessments and weight the "questions_for_recruiter" output more heavily.
- Cite the actual source you're drawing from (Crunchbase, Layoffs.fyi, Glassdoor, etc.) in evidence_sources. If you're using only general training knowledge, say so.

OVERALL:
- overall_score = round(0.40 * financial + 0.25 * culture + 0.20 * comp_implicit + 0.15 * legitimacy, 1).
  (For comp_implicit: 5 if comp clearly competitive, 3 if undisclosed, 1 if known-low.)
- recommendation = 'apply' if overall ≥ 4.0; 'hold' if 3.0-3.9; 'pass' if < 3.0.

QUESTIONS FOR RECRUITER: 3-5 specific questions targeting the information gaps you couldn't resolve from public data. Things like: "What's the runway / next funding milestone?" "Were there layoffs in the last 12 months and which teams?" "What's the comp band for this level?"

OUTPUT strict JSON matching the schema. No prose outside.`;

const COMPANY_BRIEF_SCHEMA_GEMINI: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    financial_health_score: { type: SchemaType.NUMBER },
    financial_health_summary: { type: SchemaType.STRING },
    funding_summary: { type: SchemaType.STRING },
    layoffs_summary: { type: SchemaType.STRING },
    growth_signal: { type: SchemaType.STRING },
    culture_score: { type: SchemaType.NUMBER },
    culture_summary: { type: SchemaType.STRING },
    positive_themes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    concerns: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    retention_signal: { type: SchemaType.STRING },
    comp_summary: { type: SchemaType.STRING },
    legitimacy_score: { type: SchemaType.NUMBER },
    legitimacy_notes: { type: SchemaType.STRING },
    overall_score: { type: SchemaType.NUMBER },
    recommendation: { type: SchemaType.STRING, format: 'enum', enum: ['apply', 'hold', 'pass'] },
    questions_for_recruiter: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    evidence_sources: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          label: { type: SchemaType.STRING },
          url: { type: SchemaType.STRING },
        },
        required: ['label', 'url'],
      },
    },
  },
  required: [
    'financial_health_score', 'financial_health_summary', 'funding_summary', 'layoffs_summary', 'growth_signal',
    'culture_score', 'culture_summary', 'positive_themes', 'concerns', 'retention_signal',
    'comp_summary', 'legitimacy_score', 'legitimacy_notes', 'overall_score', 'recommendation',
    'questions_for_recruiter', 'evidence_sources',
  ],
};

const COMPANY_BRIEF_SCHEMA_ANTHROPIC = {
  type: 'object' as const,
  properties: {
    financial_health_score: { type: 'number' as const },
    financial_health_summary: { type: 'string' as const },
    funding_summary: { type: 'string' as const },
    layoffs_summary: { type: 'string' as const },
    growth_signal: { type: 'string' as const },
    culture_score: { type: 'number' as const },
    culture_summary: { type: 'string' as const },
    positive_themes: { type: 'array' as const, items: { type: 'string' as const } },
    concerns: { type: 'array' as const, items: { type: 'string' as const } },
    retention_signal: { type: 'string' as const },
    comp_summary: { type: 'string' as const },
    legitimacy_score: { type: 'number' as const },
    legitimacy_notes: { type: 'string' as const },
    overall_score: { type: 'number' as const },
    recommendation: { type: 'string' as const, enum: ['apply', 'hold', 'pass'] },
    questions_for_recruiter: { type: 'array' as const, items: { type: 'string' as const } },
    evidence_sources: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          label: { type: 'string' as const },
          url: { type: 'string' as const },
        },
        required: ['label', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'financial_health_score', 'financial_health_summary', 'funding_summary', 'layoffs_summary', 'growth_signal',
    'culture_score', 'culture_summary', 'positive_themes', 'concerns', 'retention_signal',
    'comp_summary', 'legitimacy_score', 'legitimacy_notes', 'overall_score', 'recommendation',
    'questions_for_recruiter', 'evidence_sources',
  ],
  additionalProperties: false,
};

export async function researchCompany(
  companyName: string,
  industryHint = '',
  candidateLocation = '',
  exampleRole = '',
): Promise<CompanyBrief> {
  // Inject ground-truth from local caches: Layoffs.fyi (always available, bulk-ingested)
  // + Levels.fyi (cached on first view via the comp panel — may not be in DB yet).
  // The brief LLM is instructed to TRUST these over its training-data guess.
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let groundTruthBlock = '';
  try {
    const { summarizeLayoffsForPrompt } = await import('./layoffs');
    const layoffsLine = summarizeLayoffsForPrompt(slug);

    const compRow = db
      .prepare(
        'SELECT region, median_total_usd, sample_count FROM compensation_data WHERE company_slug = ? ORDER BY fetched_at DESC LIMIT 1',
      )
      .get(slug) as { region: string; median_total_usd: number | null; sample_count: number } | undefined;
    const compLine = compRow?.median_total_usd
      ? `Levels.fyi: median total comp ~$${compRow.median_total_usd.toLocaleString()} USD/yr (${compRow.region}, ${compRow.sample_count} reports).`
      : 'Levels.fyi: no comp data cached yet for this company.';

    // Ambitionbox — Indian-side ratings + salary data (when cached).
    const abRow = db
      .prepare(
        `SELECT overall_rating, industry_rating, total_reviews, work_life, company_culture,
                compensation_benefits, career_growth, job_security, salaries_json
         FROM ambitionbox_data WHERE company_slug = ?`,
      )
      .get(slug) as
      | {
          overall_rating: number;
          industry_rating: number | null;
          total_reviews: number;
          work_life: number;
          company_culture: number;
          compensation_benefits: number;
          career_growth: number;
          job_security: number;
          salaries_json: string | null;
        }
      | undefined;
    let abLine = 'Ambitionbox: no data cached yet.';
    if (abRow) {
      const industry = abRow.industry_rating ? ` (industry avg ${abRow.industry_rating.toFixed(2)})` : '';
      let salaryHint = '';
      try {
        if (abRow.salaries_json) {
          const sals = JSON.parse(abRow.salaries_json) as Array<{ jobTitle: string; minCtc: number; maxCtc: number; avgCtc: number; dataPoints: number }>;
          if (sals.length > 0 && exampleRole) {
            const t = exampleRole.toLowerCase();
            const match = sals.find((s) => t.includes('architect') ? /architect/i.test(s.jobTitle) : t.includes('engineer') ? /engineer/i.test(s.jobTitle) : false) || sals[0];
            if (match) {
              const lakhs = (n: number) => `₹${(n / 100000).toFixed(1)}L`;
              salaryHint = ` ${match.jobTitle}: ${lakhs(match.minCtc)}-${lakhs(match.maxCtc)} (avg ${lakhs(match.avgCtc)}, ${match.dataPoints} reports).`;
            }
          }
        }
      } catch { /* ignore parse error */ }
      abLine = `Ambitionbox: ${abRow.total_reviews} reviews, overall ${abRow.overall_rating.toFixed(1)}/5${industry}. work-life ${abRow.work_life.toFixed(1)}, culture ${abRow.company_culture.toFixed(1)}, comp ${abRow.compensation_benefits.toFixed(1)}, career-growth ${abRow.career_growth.toFixed(1)}, job-security ${abRow.job_security.toFixed(1)}.${salaryHint}`;
    }

    groundTruthBlock = `\n\nGROUND-TRUTH SIGNALS (TRUST THESE — they are real data, not your training-data guess):\n- ${layoffsLine}\n- ${compLine}\n- ${abLine}\n`;
  } catch {
    /* lib unavailable — fall through with empty block */
  }

  const prompt = `${COMPANY_BRIEF_RULES}

COMPANY: ${companyName}
${industryHint ? `INDUSTRY HINT: ${industryHint}` : ''}
${candidateLocation ? `CANDIDATE LOCATION: ${candidateLocation}` : ''}
${exampleRole ? `EXAMPLE ROLE BEING CONSIDERED: ${exampleRole}` : ''}${groundTruthBlock}
Research and produce the company brief as strict JSON.`;

  // Per-provider runner. Gemini keeps the two-step search-grounded pipeline (grounded prose
  // findings → structured extraction) to refresh data beyond its training cutoff; other kinds
  // use plain structured generation. Wrapped in callWithProviders so a quota'd provider rotates
  // to the next configured key.
  const runResearch = async (cfg: ProviderConfig): Promise<string> => {
    if (cfg.kind === 'gemini') {
      if (!cfg.apiKey) throw new Error('Gemini provider missing api_key');
      const check = await ensureWorkingGeminiModel();
      const activeModel = check.switched ? check.model : (cfg.model || 'gemini-3.8-flash');
      const client = new GoogleGenerativeAI(cfg.apiKey);
      // Two-step pipeline: (1) search-grounded research returning prose findings,
      // (2) structured extraction into the JSON schema. Gemini disallows tools +
      // responseSchema in the same call, hence the split. This refreshes data
      // beyond the model's training cutoff (critical for layoffs/funding signals).
      let groundedFindings = '';
      try {
        const today = new Date().toISOString().slice(0, 10);
        const searchPrompt = `You are gathering RECENT public information to evaluate ${companyName} as a potential employer. Today is ${today}.

Search for and summarize:
1. Latest funding round / financials / IPO status / parent company (if subsidiary)
2. Layoffs in the last 24 months (sizes, dates, departments) — check Layoffs.fyi
3. Headcount trend / hiring velocity / recent leadership changes
4. Glassdoor / Ambitionbox sentiment — recurring positive themes and concerns
5. Compensation band on Levels.fyi or similar for ${exampleRole || 'similar senior roles'} ${candidateLocation ? 'in ' + candidateLocation : ''}
6. Any recent news (last 6 months): scandals, lawsuits, M&A, product wins/failures, leadership changes

Output: 6 short sections, one per topic above, with the most recent dated facts you can find. Cite source URLs inline as [Source: URL]. Keep it factual; no opinion.`;

        const groundedModel = client.getGenerativeModel({
          model: activeModel,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [{ googleSearchRetrieval: {} } as any],
          generationConfig: { maxOutputTokens: 4096 },
        });
        // Google-Search-grounded call: an extra network hop on top of the model, so bound it too.
        const groundedResult = await withLlmTimeout(groundedModel.generateContent(searchPrompt), 'gemini grounded search');
        groundedFindings = groundedResult.response.text() || '';
      } catch (e) {
        // Search grounding may not be enabled on this API key / model.
        // Fall through with empty findings — the brief will be derived from training data only.
        console.log('[researchCompany] Search grounding unavailable, falling back to training-data-only:', (e as Error).message);
      }

      const promptWithFindings = groundedFindings
        ? `${prompt}\n\nRECENT WEB-SOURCED FINDINGS (use these as authoritative for funding/layoffs/news; cite the URLs as evidence_sources):\n${groundedFindings}`
        : prompt;

      const model = client.getGenerativeModel({
        model: activeModel,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: COMPANY_BRIEF_SCHEMA_GEMINI,
          maxOutputTokens: 8192,
        },
      });
      const result = await model.generateContent(promptWithFindings);
      const text = result.response.text();
      if (!text) throw new Error('Gemini returned empty company brief');
      return text;
    }
    // Non-Gemini providers: plain structured generation.
    return runStructured(cfg, prompt, COMPANY_BRIEF_SCHEMA_GEMINI, COMPANY_BRIEF_SCHEMA_ANTHROPIC, 4096);
  };

  const text = await callWithProviders(runResearch);
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error('researchCompany: no JSON in model output');
  return JSON.parse(match[0]) as CompanyBrief;
}

export async function formatJobDescription(rawDescription: string, jobTitle: string, companyName: string): Promise<string> {
  if (!rawDescription || rawDescription.trim().length < 100) {
    return rawDescription;
  }
  const prompt = `${JD_FORMAT_RULES}

JOB TITLE: ${jobTitle}
COMPANY: ${companyName}

RAW JOB DESCRIPTION:
${rawDescription.slice(0, 12000)}

Return the formatted Markdown:`;
  return callWithProviders(
    (cfg) =>
      callProviderConfig(
        { kind: cfg.kind, model: cfg.model, api_key: cfg.apiKey, base_url: cfg.baseUrl },
        prompt,
        4096,
      ),
    4096,
  );
}

export interface ResumeVariantResult {
  text: string;
  coverage: KeywordCoverage;
}

export async function generateResumeVariant(
  resumeJson: object,
  jobTitle: string,
  company: string,
  jobDescription: string,
  /** Pass `{ interactive: true }` when a user is waiting — see LLM_INTERACTIVE_TIMEOUT_MS. */
  opts: { interactive?: boolean } = {},
): Promise<ResumeVariantResult> {
  // Resumes can carry more keywords than cover letters — use 15.
  const keywords = extractJdKeywords(jobDescription, jobTitle, 15);
  const requiredList = keywords.map((k) => k.term);
  const keywordsBlock = requiredList.length
    ? `\n\nREQUIRED ATS KEYWORDS (Ensure all these terms appear verbatim in ## Skills and are seamlessly incorporated into experience / project bullets to achieve 99% ATS match):\n${requiredList.join(', ')}\n`
    : '';

  const prompt = `${RESUME_VARIANT_RULES}

ORIGINAL RESUME:
${JSON.stringify(resumeJson, null, 2)}

TARGET JOB TITLE: ${jobTitle}
TARGET COMPANY: ${company}

JOB DESCRIPTION:
${jobDescription.slice(0, 3000)}${keywordsBlock}
Write the optimized resume now:`;

  // Same last-resort as the cover letter, for the same reason.
  //
  // The apply preview no longer generates this (that caused a 277s hang), so it is produced when the
  // user presses Submit — meaning a provider failure here breaks an application mid-flight. It is
  // also the same risk profile as a cover letter: a draft the user reads before anything is sent, so
  // a weaker local model is far better than nothing. Ratings deliberately do NOT get this fallback,
  // because a bad rating silently mis-sorts the whole list.
  let text: string;
  try {
    text = await primaryGenerate(prompt, 4096, 'creative', {
      timeoutMs: opts.interactive ? LLM_INTERACTIVE_TIMEOUT_MS : undefined,
    });
  } catch (e) {
    if (!opts.interactive) throw e;
    const why = e instanceof Error ? e.message.slice(0, 120) : String(e);
    console.warn(`[creative] résumé variant generation failed — no local fallback available (${why})`);
    throw e;
  }
  const { matched, missing } = matchKeywordsInText(text, keywords);
  return { text, coverage: { required: requiredList, matched, missing } };
}

const PARSE_INSTRUCTIONS = `Extract ONLY information explicitly stated in this resume. Be thorough — extract ALL skills from ALL sections including technical skills, tools, platforms, frameworks, languages, and methodologies.

Fields:
- name: the candidate's full name (usually the first heading or top of the page)
- email: their email address if present
- phone: phone number if present
- linkedin: full LinkedIn URL if present (e.g. https://linkedin.com/in/...)
- skills: array of ALL individual technical skills, tools, platforms, and technologies mentioned
- experience: array of strings, each being a job entry. Format each as "Title at Company (start_date - end_date)" — preserve dates and any company context. Then for each experience entry, append a separator and 3-5 of the strongest accomplishments/responsibilities verbatim from the resume, joined with " | ". Example: "Tech Lead at Acme Corp (Jan 2020 - Present) | Architected FHIR integration | Led team of 8 | Reduced API latency 60%"
- education: array of degrees with institutions and graduation year if present
- location: the person's location/city/country
- seniority: one of "junior", "mid", "senior", "lead", "architect", "director", "vp", "executive"
- title: their current/most recent job title
- yearsOfExperience: number of years of experience mentioned`;

// Anthropic's JSON-schema format
const RESUME_JSON_SCHEMA_ANTHROPIC = {
  type: 'object' as const,
  properties: {
    name: { type: 'string' as const },
    email: { type: 'string' as const },
    phone: { type: 'string' as const },
    linkedin: { type: 'string' as const },
    skills: { type: 'array' as const, items: { type: 'string' as const } },
    experience: { type: 'array' as const, items: { type: 'string' as const } },
    education: { type: 'array' as const, items: { type: 'string' as const } },
    location: { type: 'string' as const },
    seniority: {
      type: 'string' as const,
      enum: ['junior', 'mid', 'senior', 'lead', 'architect', 'director', 'vp', 'executive'],
    },
    title: { type: 'string' as const },
    yearsOfExperience: { type: 'number' as const },
  },
  required: ['skills', 'experience', 'education'],
  additionalProperties: false,
};

// Gemini's schema format uses SchemaType enum
const RESUME_JSON_SCHEMA_GEMINI: any = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING },
    email: { type: SchemaType.STRING },
    phone: { type: SchemaType.STRING },
    linkedin: { type: SchemaType.STRING },
    skills: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    experience: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    education: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    location: { type: SchemaType.STRING },
    seniority: { type: SchemaType.STRING, enum: ['junior', 'mid', 'senior', 'lead', 'architect', 'director', 'vp', 'executive'] },
    title: { type: SchemaType.STRING },
    yearsOfExperience: { type: SchemaType.NUMBER },
  },
  required: ['skills', 'experience', 'education'],
};

export async function parseResume(rawText: string): Promise<ParsedResume> {
  const prompt = `${PARSE_INSTRUCTIONS}\n\nRESUME TEXT:\n${rawText.slice(0, 20000)}`;
  const text = await callWithProviders((cfg) =>
    runStructured(cfg, prompt, RESUME_JSON_SCHEMA_GEMINI, RESUME_JSON_SCHEMA_ANTHROPIC, 4096),
    4096,
  );
  const m = text.trim().match(/\{[\s\S]*\}/);
  if (!m) throw new Error('parseResume: no JSON in model output');
  return JSON.parse(m[0]) as ParsedResume;
}

// ---------------------------------------------------------------------------
// Adaptive role targeting — derive the set of role titles / search terms that
// genuinely fit this resume, instead of relying on hardcoded SEARCH_QUERIES.
// Output drives (a) the keyword ingestion scrapers + career-page discovery and
// (b) a soft ranking boost in the matcher. Healthcare-first but deliberately
// broad (senior tech/architect across industries) — the user curates the list
// on /profile, so over-suggesting is fine; under-suggesting loses coverage.
// Provider-agnostic: uses primaryGenerate + tolerant JSON-array extraction so
// it works on Groq/Freeway/etc. without per-provider schema plumbing.
// ---------------------------------------------------------------------------

const DERIVE_ROLES_RULES = `You are a job-search strategist. Given a candidate's parsed resume, output the set of JOB TITLES / SEARCH TERMS to hunt for on job boards and company career pages.

RULES:
- Return 8 to 15 role titles, ordered best-fit first.
- Base them ONLY on the candidate's actual seniority, skills, and experience — never suggest roles they aren't qualified for.
- Match the candidate's level (a 15-year architect should NOT get junior/mid titles).
- Prioritize the candidate's core domain first (e.g. healthcare interoperability), THEN broaden to adjacent senior roles the same skills qualify them for across other industries (e.g. Solution Architect, Principal Engineer, Cloud/Data Platform Architect, Integration Architect). Breadth matters — the candidate wants to see all genuinely-matching roles, not only their niche.
- Use real, board-searchable titles (what a recruiter would post), not sentences or skill phrases.
- No seniority prefixes the candidate hasn't earned; no company names; no locations.
- Output ONLY a JSON array of strings. No markdown fences, no prose. Example: ["Solution Architect","Healthcare Integration Architect","Principal Engineer"]`;

export async function deriveTargetRoles(resumeJson: object): Promise<string[]> {
  const prompt = `${DERIVE_ROLES_RULES}

CANDIDATE RESUME:
${JSON.stringify(resumeJson, null, 2)}

Return the JSON array of role titles now:`;

  const text = await primaryGenerate(prompt, 1024);
  // Tolerant extraction — grab the first JSON array in the output.
  const match = text.trim().match(/\[[\s\S]*\]/);
  if (!match) throw new Error('deriveTargetRoles: no JSON array in model output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error('deriveTargetRoles: model output was not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('deriveTargetRoles: output was not an array');
  // Normalize: strings only, trimmed, de-duped (case-insensitive), capped at 15.
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const role = item.trim().replace(/\s+/g, ' ');
    if (!role || role.length > 80) continue;
    const key = role.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roles.push(role);
    if (roles.length >= 15) break;
  }
  return roles;
}

// ---------------------------------------------------------------------------
// Adaptive DOMAIN targeting — derive the vocabulary (technologies, standards,
// domain terms) that characterises a strong-fit role for THIS resume, instead of
// the hardcoded healthcare ontology (src/lib/ontology.ts). Drives the matcher's
// soft +0.05 "domain boost": a job whose title+description contains ≥3 of these
// terms is nudged up. Resume-derived, so the boost follows whatever the candidate
// actually does — healthcare terms still win for a healthcare resume, but a cloud
// or fintech resume gets its own vocabulary instead of being out-boosted. The user
// curates the list as "Focus areas" chips on /profile.
// ---------------------------------------------------------------------------

const DERIVE_DOMAINS_RULES = `You are a job-search strategist. Given a candidate's parsed resume, output the DOMAIN VOCABULARY that signals a strong-fit job — the specific technologies, platforms, standards, methodologies, and industry terms whose presence in a job description means "this role is squarely in my wheelhouse."

RULES:
- Return 12 to 25 terms, ordered most-characteristic first.
- Draw them from the candidate's ACTUAL skills, tools, standards, and industry experience — never generic filler ("communication", "teamwork", "problem solving").
- Include a mix: core technologies/platforms, domain standards/regulations, and the industry/sector the candidate works in.
- Prefer terms a job description would literally contain (e.g. "FHIR", "Kubernetes", "HL7", "Terraform", "PCI DSS", "microservices"), not sentences or soft skills.
- Keep each term short (1-4 words). No company names, no locations, no seniority words.
- Output ONLY a JSON array of strings. No markdown fences, no prose. Example: ["FHIR","HL7","interoperability","Azure","microservices","Kubernetes"]`;

// Tolerant extraction of a term list from arbitrary model output. Some providers (the fallback
// provider) frequently ignores "JSON only" and returns prose, bullets, or fenced code —
// which is what made a strict `[...]`-or-throw parse fail. Tries a JSON array first, then
// quoted strings, then line/comma splitting.
function salvageTermList(text: string): string[] {
  const t = (text || '').trim();
  // 1) A real JSON array anywhere in the output.
  const arr = t.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      const parsed = JSON.parse(arr[0]);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    } catch { /* fall through to prose salvage */ }
  }
  // 2) Quoted strings scattered in prose.
  const quoted: string[] = [];
  const quoteRe = /"([^"]{1,40})"/g;
  let qm: RegExpExecArray | null;
  while ((qm = quoteRe.exec(t)) !== null) quoted.push(qm[1]);
  if (quoted.length >= 3) return quoted;
  // 3) Line / comma split: strip bullets, numbering, fences, quotes.
  return t
    .replace(/```[a-z]*/gi, '')
    .split(/[\n,]+/)
    .map((s) => s.replace(/^[\s\-*•\d.)]+/, '').replace(/["'`]/g, '').trim())
    .filter((s) => s && s.length <= 40 && !/^(json|here|the following|domain|terms?|output)\b/i.test(s));
}

export async function deriveDomainTerms(resumeJson: object): Promise<string[]> {
  const prompt = `${DERIVE_DOMAINS_RULES}

CANDIDATE RESUME:
${JSON.stringify(resumeJson, null, 2)}

Return the JSON array of domain terms now:`;

  let raw: string[] = [];
  try {
    const text = await primaryGenerate(prompt, 1024);
    raw = salvageTermList(text);
  } catch (e) {
    console.warn('[deriveDomainTerms] LLM call failed:', e instanceof Error ? e.message : e);
  }
  // Fallback: if the model gave us too little (flaky/quota-limited provider), seed from the
  // resume's own parsed skills — they're already domain vocabulary, so this never hard-fails.
  if (raw.length < 3) {
    const skills = Array.isArray((resumeJson as { skills?: unknown }).skills)
      ? (resumeJson as { skills: unknown[] }).skills.filter((s): s is string => typeof s === 'string')
      : [];
    raw = [...raw, ...skills];
  }
  // Normalize: strings only, trimmed, de-duped (case-insensitive), capped at 25.
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of raw) {
    const term = item.trim().replace(/\s+/g, ' ');
    if (!term || term.length > 40) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 25) break;
  }
  return terms;
}
