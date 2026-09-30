// Provider-aware embeddings (Gemini default, OpenAI / OpenAI-compatible supported).
//
// Google Gemini (text-embedding-004) is the default cloud embedding provider.
// Resolution is env-based (per-instance). Every embedding in a DB must share the same model/vector space.

import db from './db';

export type EmbeddingKind = 'gemini' | 'openai' | 'openai-compatible';

interface EmbeddingConfig {
  kind: EmbeddingKind;
  model: string;
  apiKey: string | null;
  baseUrl: string;
}

const EMBED_TIMEOUT_MS = 30_000;
const EMBED_RETRIES = 5; // retry attempts with exponential backoff on 429
const EMBED_MAX_CHARS = 6000;

const DEFAULT_MODELS: Record<EmbeddingKind, string> = {
  gemini: 'gemini-embedding-001',
  openai: 'text-embedding-3-small',
  'openai-compatible': 'text-embedding-3-small',
};

const KINDS: EmbeddingKind[] = ['gemini', 'openai', 'openai-compatible'];

function getDbApiKey(providerKind: string): string | null {
  try {
    const row = db
      .prepare("SELECT api_key FROM llm_providers WHERE kind = ? AND api_key IS NOT NULL AND is_active = 1 LIMIT 1")
      .get(providerKind) as { api_key: string } | undefined;
    if (row?.api_key) return row.api_key;
    const anyRow = db
      .prepare("SELECT api_key FROM llm_providers WHERE kind = ? AND api_key IS NOT NULL LIMIT 1")
      .get(providerKind) as { api_key: string } | undefined;
    return anyRow?.api_key || null;
  } catch {
    return null;
  }
}

function resolveEmbeddingConfig(): EmbeddingConfig {
  let raw = process.env.EMBEDDING_PROVIDER ? process.env.EMBEDDING_PROVIDER.toLowerCase() : 'gemini';
  if (raw === 'ollama') raw = 'gemini';
  const kind: EmbeddingKind = (KINDS as string[]).includes(raw) ? (raw as EmbeddingKind) : 'gemini';
  const model = process.env.EMBEDDING_MODEL || DEFAULT_MODELS[kind] || 'gemini-embedding-001';
  const apiKey =
    process.env.EMBEDDING_API_KEY ||
    (kind === 'gemini' ? process.env.GEMINI_API_KEY || getDbApiKey('gemini')
      : kind === 'openai' ? process.env.OPENAI_API_KEY || getDbApiKey('openai')
      : null);
  const baseUrl =
    process.env.EMBEDDING_BASE_URL ||
    (kind === 'openai' ? 'https://api.openai.com/v1'
      : kind === 'gemini' ? 'https://generativelanguage.googleapis.com/v1'
      : ''); // openai-compatible must set EMBEDDING_BASE_URL
  return { kind, model, apiKey, baseUrl };
}

/** The active embedding provider + model — for diagnostics, settings display, and logs. */
export function getEmbeddingInfo(): { provider: EmbeddingKind; model: string } {
  const c = resolveEmbeddingConfig();
  return { provider: c.kind, model: c.model };
}

/**
 * Identity of the current embedding space, "provider:model". Everything in one DB must share
 * this — the signature guard (embedding-signature.ts) records it on first embed and refuses to
 * embed into a corpus produced by a different signature.
 */
export function getEmbeddingSignature(): string {
  const c = resolveEmbeddingConfig();
  return `${c.kind}:${c.model}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Should a failed attempt be retried? Transient: network blips, 5xx, timeouts, 429 rate limits.
function isTransient(msg: string): boolean {
  return /aborted|fetch failed|ECONNREFUSED|ECONNRESET|network|timeout|\b(5\d\d|429)\b/i.test(msg);
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

// --- per-provider batch embedders (one vector per input, order-preserving) ---

async function embedOpenAI(cfg: EmbeddingConfig, inputs: string[]): Promise<number[][]> {
  if (!cfg.apiKey) throw new Error(`Embedding provider "${cfg.kind}" needs an API key (EMBEDDING_API_KEY)`);
  if (!cfg.baseUrl) throw new Error('openai-compatible embeddings require EMBEDDING_BASE_URL');
  const data = await fetchJson(`${cfg.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, input: inputs }),
  });
  const rows = (data.data as Array<{ embedding: number[]; index: number }>) || [];
  // Responses are index-tagged; sort to guarantee input order.
  return rows.slice().sort((a, b) => a.index - b.index).map((r) => r.embedding);
}

async function embedGemini(cfg: EmbeddingConfig, inputs: string[]): Promise<number[][]> {
  if (!cfg.apiKey) throw new Error('Gemini embeddings need an API key (EMBEDDING_API_KEY or GEMINI_API_KEY)');
  const modelPath = `models/${cfg.model}`;
  // Try batchEmbedContents first (efficient, one call for many texts)
  try {
    const data = await fetchJson(`${cfg.baseUrl}/${modelPath}:batchEmbedContents?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: inputs.map((text) => ({
          model: modelPath,
          content: { parts: [{ text }] },
          outputDimensionality: 768,
        })),
      }),
    });
    const embs = (data.embeddings as Array<{ values: number[] }>) || [];
    if (embs.length === inputs.length) return embs.map((e) => e.values);
  } catch (batchErr) {
    const msg = batchErr instanceof Error ? batchErr.message : String(batchErr);
    // If outputDimensionality failed, try without it
    if (/outputDimensionality|invalid argument|unknown field/i.test(msg)) {
      try {
        const data = await fetchJson(`${cfg.baseUrl}/${modelPath}:batchEmbedContents?key=${cfg.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: inputs.map((text) => ({
              model: modelPath,
              content: { parts: [{ text }] },
            })),
          }),
        });
        const embs = (data.embeddings as Array<{ values: number[] }>) || [];
        if (embs.length === inputs.length) return embs.map((e) => e.values);
      } catch {
        // fall through to sequential
      }
    }
    // 404 means batch not supported for this key/model — fall through to sequential embedContent
    if (!/404|not found|not supported/i.test(msg)) throw batchErr;
    console.warn('[embeddings] batchEmbedContents unavailable, falling back to sequential embedContent');
  }
  // Fallback: sequential embedContent calls (works with all key types)
  const results: number[][] = [];
  for (const text of inputs) {
    try {
      const data = await fetchJson(`${cfg.baseUrl}/${modelPath}:embedContent?key=${cfg.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelPath,
          content: { parts: [{ text }] },
          outputDimensionality: 768,
        }),
      });
      const embedding = (data.embedding as { values: number[] }) || { values: [] };
      results.push(embedding.values);
    } catch {
      const data = await fetchJson(`${cfg.baseUrl}/${modelPath}:embedContent?key=${cfg.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelPath,
          content: { parts: [{ text }] },
        }),
      });
      const embedding = (data.embedding as { values: number[] }) || { values: [] };
      results.push(embedding.values);
    }
  }
  return results;
}

async function embedBatchOnce(cfg: EmbeddingConfig, inputs: string[]): Promise<number[][]> {
  switch (cfg.kind) {
    case 'openai':
    case 'openai-compatible': return embedOpenAI(cfg, inputs);
    case 'gemini': default: return embedGemini(cfg, inputs);
  }
}

/**
 * Embed a batch of texts → one Float32Array per input (order preserved). Retries transient
 * failures (network / 5xx / 429 / timeout) with exponential backoff.
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  const cfg = resolveEmbeddingConfig();
  const inputs = texts.map((t) => (t || '').slice(0, EMBED_MAX_CHARS));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= EMBED_RETRIES; attempt++) {
    try {
      const vectors = await embedBatchOnce(cfg, inputs);
      if (vectors.length !== inputs.length) {
        throw new Error(`embedding count mismatch (${vectors.length} vs ${inputs.length})`);
      }
      return vectors.map((v) => new Float32Array(v));
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < EMBED_RETRIES && isTransient(msg)) {
        // Backoff: 1s, 2s, 4s, 8s, 16s on 429 rate limit
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`Embedding (${cfg.kind}/${cfg.model}) failed: ${msg}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Embedding failed');
}

/** Embed a single text → Float32Array. Used by résumé upload and single-job import. */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const [v] = await generateEmbeddings([text]);
  return v;
}

export function embeddingToBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function blobToEmbedding(blob: Buffer): Float32Array {
  const copy = Buffer.alloc(blob.byteLength);
  blob.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
