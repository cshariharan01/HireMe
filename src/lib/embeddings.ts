// Provider-aware embeddings.
//
// Ollama (local, free) is the default, but embeddings can also come from a cloud provider so the
// app runs WITHOUT Ollama for people who don't want to (or can't) run a local model — they just
// set EMBEDDING_PROVIDER + a key. Resolution is env-based (per-instance), NOT per-call: every
// embedding in a DB must share the same model/vector space, or cosine distance is meaningless.
// Switching providers therefore requires re-embedding everything (see .env.example).
//
// Env:
//   EMBEDDING_PROVIDER  ollama | gemini | openai | openai-compatible   (default: ollama)
//   EMBEDDING_MODEL     override the model (defaults per provider below)
//   EMBEDDING_API_KEY   key for the cloud provider (falls back to GEMINI_API_KEY / OPENAI_API_KEY)
//   EMBEDDING_BASE_URL  override endpoint (required for openai-compatible; default per provider)

export type EmbeddingKind = 'ollama' | 'gemini' | 'openai' | 'openai-compatible';

interface EmbeddingConfig {
  kind: EmbeddingKind;
  model: string;
  apiKey: string | null;
  baseUrl: string;
}

const EMBED_TIMEOUT_MS = 30_000;
const EMBED_RETRIES = 2; // total attempts = 1 + retries
// nomic-embed-text has a 2048-token context; a long résumé/JD overflows it. Cap the input
// (~4 chars/token → ~6000 chars is safe). Cloud models have larger contexts but capping is
// harmless and keeps behavior/costs consistent. The head carries the strongest matching signal.
const EMBED_MAX_CHARS = 6000;

const DEFAULT_MODELS: Record<EmbeddingKind, string> = {
  ollama: 'nomic-embed-text',
  gemini: 'text-embedding-004',        // 768-dim (same as nomic)
  openai: 'text-embedding-3-small',    // 1536-dim
  'openai-compatible': 'text-embedding-3-small',
};

const KINDS: EmbeddingKind[] = ['ollama', 'gemini', 'openai', 'openai-compatible'];

function resolveEmbeddingConfig(): EmbeddingConfig {
  const raw = (process.env.EMBEDDING_PROVIDER || 'ollama').toLowerCase();
  const kind: EmbeddingKind = (KINDS as string[]).includes(raw) ? (raw as EmbeddingKind) : 'ollama';
  const model = process.env.EMBEDDING_MODEL || DEFAULT_MODELS[kind];
  const apiKey =
    process.env.EMBEDDING_API_KEY ||
    (kind === 'gemini' ? process.env.GEMINI_API_KEY || null
      : kind === 'openai' ? process.env.OPENAI_API_KEY || null
      : null);
  const baseUrl =
    process.env.EMBEDDING_BASE_URL ||
    (kind === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434')
      : kind === 'openai' ? 'https://api.openai.com/v1'
      : kind === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta'
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

async function embedOllama(cfg: EmbeddingConfig, inputs: string[]): Promise<number[][]> {
  // Prefer the batched /api/embed; if a given Ollama build lacks it, fall back to /api/embeddings.
  try {
    const data = await fetchJson(`${cfg.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, input: inputs }),
    });
    if (Array.isArray(data.embeddings)) return data.embeddings as number[][];
    throw new Error('no embeddings array in /api/embed response');
  } catch {
    const out: number[][] = [];
    for (const text of inputs) {
      const data = await fetchJson(`${cfg.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt: text }),
      });
      if (!Array.isArray(data.embedding)) throw new Error('Ollama returned no embedding array');
      out.push(data.embedding as number[]);
    }
    return out;
  }
}

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
  const data = await fetchJson(`${cfg.baseUrl}/${modelPath}:batchEmbedContents?key=${cfg.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: inputs.map((text) => ({ model: modelPath, content: { parts: [{ text }] } })),
    }),
  });
  const embs = (data.embeddings as Array<{ values: number[] }>) || [];
  return embs.map((e) => e.values);
}

async function embedBatchOnce(cfg: EmbeddingConfig, inputs: string[]): Promise<number[][]> {
  switch (cfg.kind) {
    case 'ollama': return embedOllama(cfg, inputs);
    case 'openai':
    case 'openai-compatible': return embedOpenAI(cfg, inputs);
    case 'gemini': return embedGemini(cfg, inputs);
    default: throw new Error(`Unsupported embedding provider "${cfg.kind}"`);
  }
}

/**
 * Embed a batch of texts → one Float32Array per input (order preserved). Retries transient
 * failures (network / 5xx / 429 / timeout) with backoff. Used by `npm run embed` for jobs.
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
      if (attempt < EMBED_RETRIES && isTransient(msg)) { await sleep(500 * (attempt + 1)); continue; }
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
