/**
 * Freeway — client for the local AI gateway (https://github.com/vinaygiri/freeway).
 *
 * WHY THIS EXISTS: our cloud keys (Gemini / Anthropic) have hard daily quotas. When they
 * exhaust, the provider chain in `llm.ts` used to drop straight to local Ollama `llama3.2`,
 * which is too weak for job ratings, resume tailoring and company briefs. Freeway is a local
 * gateway that fronts ~32 free-tier providers with its own quota-aware routing, mid-answer
 * failover and multi-key rotation — so an exhausted key degrades to another *capable* model
 * instead of to a small local one.
 *
 * Freeway must be running for this to work (`curl $FREEWAY_BASE_URL/health`). It is never
 * required: if `FREEWAY_API_KEY` is unset, `isFreewayEnabled()` is false and the provider
 * chain behaves exactly as before.
 *
 * We use `POST /api/v1/ask` (Freeway's plain JSON endpoint) rather than its OpenAI or
 * Anthropic ingress: `/v1/messages` always streams regardless of the request and
 * `/v1/responses` refuses non-streaming outright — both exist to serve Claude Code / Codex.
 *
 * TWO THINGS FREEWAY DOES NOT DO, both verified in its source:
 *   1. No `/v1/embeddings`, and embedding-type models are filtered out of its routable
 *      catalog — embeddings stay on Ollama `nomic-embed-text` (see `src/lib/embeddings.ts`).
 *   2. No structured-output passthrough. `response_format` is never read, and its canonical
 *      internal request marks `output_config` / `extra_body` as "accepted but never
 *      forwarded". Gemini `responseSchema` and Anthropic `output_config` therefore do NOT
 *      survive the proxy, so JSON has to be coached in the prompt and extracted by the
 *      caller — the same path `llm.ts` already uses for Ollama.
 */

const DEFAULT_BASE_URL = 'http://localhost:8092';

// Floor for any call. Free-tier models are slow and Freeway may fail over internally mid-request,
// so a typical 30s client budget produces spurious failures.
const MIN_TIMEOUT_MS = 120_000;
// Reasoning models emit thinking tokens at a roughly steady rate, so the honest timeout scales
// with the token budget rather than being one flat number. Measured on this gateway: a 4096-token
// structured evaluation took 34s, 50s, and once >120s (it tripped the old flat 120s cap and the
// chain fell through to Gemini). 60ms/token puts a 4096-token call at ~245s, a short 512-token
// call at the 120s floor. Override per-call with `timeoutMs`, or globally with FREEWAY_TIMEOUT_MS.
const MS_PER_TOKEN = 60;

/**
 * Exported so `callWithProviders` can size its OUTER ceiling above this one.
 *
 * A flat outer timeout below this value silently re-imposes the exact cap this scaling exists to
 * remove: the outer race wins, the attempt is recorded as a Freeway failure, and the chain falls
 * through to paid Gemini for precisely the slow evaluations Freeway is meant to absorb.
 */
export function freewayTimeoutFor(maxTokens: number, explicit?: number): number {
  return timeoutFor(maxTokens, explicit);
}

function timeoutFor(maxTokens: number, explicit?: number): number {
  if (explicit) return explicit;
  const fromEnv = Number(process.env.FREEWAY_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(MIN_TIMEOUT_MS, maxTokens * MS_PER_TOKEN);
}

// Freeway's configured default (nvidia/nemotron-3-super-120b-a12b:free) is a REASONING model:
// its thinking is billed against the same budget as the answer. Measured against the live
// gateway, max_tokens=80 returned the model's reasoning instead of the answer; 400 answered
// correctly. Anything we send is floored here so a small caller budget can't produce
// reasoning-instead-of-answer or an empty reply.
const MIN_MAX_TOKENS = 512;

// Free tier behind the gateway is roughly 50 req/day and 20/min (OpenRouter is the binding
// constraint). Freeway already retries and fails over internally, so ONE retry on 502 is the
// most a client should ever add — more just retries on top of retries and burns the daily cap.
const RETRY_ON_502 = 1;
const RETRY_BACKOFF_MS = 1_500;

export function freewayBaseUrl(): string {
  return (process.env.FREEWAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function freewayApiKey(): string | null {
  return process.env.FREEWAY_API_KEY?.trim() || null;
}

/**
 * Freeway enforces auth on every endpoint except /health, so a missing key means every call
 * would 401 — we treat "no key" as "not configured" and stay out of the provider chain.
 */
export function isFreewayEnabled(): boolean {
  return !!freewayApiKey();
}

/** `"auto"` / empty means "let Freeway route" — the model field is then omitted entirely. */
export function freewayModelOrAuto(model: string | null | undefined): string | undefined {
  const m = model?.trim();
  if (!m || m === 'auto' || m === 'freeway' || m === 'freeway/auto') return undefined;
  return m;
}

/**
 * Accept whichever Freeway URL the user pasted and reduce it to the gateway root.
 * People naturally enter `http://localhost:8092`, `.../v1` (the OpenAI ingress) or even
 * `.../api/v1/ask`; all three mean the same gateway, and we append our own path.
 */
export function normalizeFreewayBase(baseUrl: string | null | undefined): string | null {
  const raw = baseUrl?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '').replace(/\/api\/v1\/ask$/i, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
}

/** True when `baseUrl` addresses the same host:port as our configured Freeway. */
export function pointsAtFreeway(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  const hostPort = (u: string): string | null => {
    try {
      const parsed = new URL(u.includes('://') ? u : `http://${u}`);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      // localhost and 127.0.0.1 are the same gateway as far as we care.
      const host = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(parsed.hostname) ? 'local' : parsed.hostname.toLowerCase();
      return `${host}:${port}`;
    } catch {
      return null;
    }
  };
  const a = hostPort(baseUrl);
  const b = hostPort(freewayBaseUrl());
  return !!a && !!b && a === b;
}

export interface FreewayUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface FreewayAnswer {
  text: string;
  /** Which model actually served it — may differ from what was asked for. */
  modelUsed: string | null;
  /** True when the primary was unavailable and another provider served the call. Not an error. */
  wasFallback: boolean;
  stopReason: string | null;
  usage: FreewayUsage;
  toolCalls: unknown[];
}

/** Freeway error shape: `{"error": {"type": "...", "message": "..."}}`. */
export class FreewayError extends Error {
  readonly status: number;
  readonly type: string;
  /** 502 = every candidate provider failed; safe to retry once. Everything else is not. */
  readonly retryable: boolean;

  constructor(status: number, type: string, message: string) {
    super(message);
    // Kept deliberately. `tsconfig.json` NOW sets "target": "ES2017" (Next 15's build wrote it in),
    // so subclassing Error works and this is belt-and-braces rather than load-bearing. It used to
    // be essential: with no target, tsc defaults to ES5, where subclassing a built-in loses the
    // prototype and `instanceof` is always false — which silently sent every error down the
    // "not retryable" branch in ts-node scripts. Leaving it means a future target change can't
    // quietly reintroduce that bug.
    // Next compiles with a modern target so the app was fine, but ts-node scripts
    // (evaluate:top, test-freeway) would silently take the "not retryable" branch.
    Object.setPrototypeOf(this, FreewayError.prototype);
    this.name = 'FreewayError';
    this.status = status;
    this.type = type;
    this.retryable = status === 502;
  }
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return 'Freeway rejected the API key — check FREEWAY_API_KEY (issue/revoke keys in Freeway admin under Monitor -> API Keys)';
    case 400:
      return 'Freeway rejected the request as malformed (it would fail identically on every provider)';
    case 502:
      return 'every provider Freeway tried failed';
    case 503:
      return 'Freeway has no routable model available — check its Providers page for a working key';
    default:
      return `Freeway HTTP ${status}`;
  }
}

async function toFreewayError(res: Response): Promise<FreewayError> {
  let type = 'api_error';
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { type?: string; message?: string }; detail?: string };
    type = body.error?.type || type;
    detail = body.error?.message || body.detail || '';
  } catch {
    /* non-JSON body — the status alone is the signal */
  }
  const summary = describeStatus(res.status);
  return new FreewayError(res.status, type, detail ? `${summary}: ${detail.slice(0, 300)}` : summary);
}

/**
 * Abort controller that fires on our timeout OR on a caller-supplied signal, whichever first.
 * A generous timeout is deliberate: these are free-tier models, and a slow one plus an internal
 * Freeway failover can legitimately take a while. A 30s budget produces spurious failures.
 */
function withTimeout(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Freeway request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

export interface AskOptions {
  /**
   * Key/base URL for THIS call, overriding the env vars. Set when the caller has a configured
   * `llm_providers` row (kind='freeway') — a provider added in /settings keeps its credentials
   * in the DB like every other provider, and the env vars are only the fallback.
   */
  apiKey?: string | null;
  baseUrl?: string | null;
  /** Optional system instructions. */
  system?: string;
  /**
   * Optional `"provider/model"` pin (e.g. `cerebras/gpt-oss-120b`). OMIT to let Freeway route
   * to whatever is alive and still has quota — that is the whole point of the gateway. Note an
   * unrecognised name is NOT an error: it silently falls through to Freeway's configured
   * default, so never derive routing logic from this string.
   */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Stream text deltas; `onDelta` receives each partial. The resolved answer is still complete. */
  stream?: boolean;
  onDelta?: (delta: string) => void;
  /** Overrides the default budget-scaled timeout (see timeoutFor). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Free-text tag for the log line, so we can tell which feature made the call. */
  label?: string;
}

function logServed(answer: FreewayAnswer, label: string | undefined, ms: number): void {
  const tag = label ? `freeway:${label}` : 'freeway';
  const fallback = answer.wasFallback ? ' (fallback)' : '';
  const io = `${answer.usage.inputTokens ?? '?'}->${answer.usage.outputTokens ?? '?'} tok`;
  console.log(
    `[${tag}] served by ${answer.modelUsed ?? 'unknown'}${fallback} in ${ms}ms, ${io}, stop=${answer.stopReason ?? '?'}`,
  );
}

function toAnswer(payload: Record<string, unknown>): FreewayAnswer {
  const usage = (payload.usage as { input_tokens?: number; output_tokens?: number } | undefined) || {};
  return {
    text: typeof payload.text === 'string' ? payload.text : '',
    modelUsed: typeof payload.model_used === 'string' ? payload.model_used : null,
    wasFallback: payload.was_fallback === true,
    stopReason: typeof payload.stop_reason === 'string' ? payload.stop_reason : null,
    usage: { inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null },
    toolCalls: Array.isArray(payload.tool_calls) ? payload.tool_calls : [],
  };
}

/**
 * `GET /health` — the one unauthenticated endpoint. Freeway takes ~30-50s to become ready on
 * first boot (it discovers models from every configured provider), so a freshly started
 * gateway can be listening but not yet answering requests.
 */
/**
 * Ping the gateway's unauthenticated /health endpoint.
 *
 * `baseUrl` matters: this used to ALWAYS check `freewayBaseUrl()` (the env default), even when the
 * caller had a provider row configured with a different address. The /settings "Test" button then
 * health-checked the wrong gateway — reporting healthy while the user's actual configured URL was
 * down, or the reverse. Pass the configured base; it falls back to the env default when omitted.
 */
export async function freewayHealth(timeoutMs = 5_000, baseUrl?: string | null): Promise<boolean> {
  const { signal, done } = withTimeout(timeoutMs);
  const base = normalizeFreewayBase(baseUrl) || freewayBaseUrl();
  try {
    const res = await fetch(`${base}/health`, { signal, cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === 'healthy';
  } catch {
    return false;
  } finally {
    done();
  }
}

async function askOnce(prompt: string, options: AskOptions): Promise<FreewayAnswer> {
  const key = options.apiKey?.trim() || freewayApiKey();
  if (!key) {
    throw new FreewayError(401, 'config_error', 'No Freeway API key — add the provider in /settings or set FREEWAY_API_KEY');
  }
  const base = normalizeFreewayBase(options.baseUrl) || freewayBaseUrl();

  const budget = Math.max(options.maxTokens ?? MIN_MAX_TOKENS, MIN_MAX_TOKENS);
  const body: Record<string, unknown> = {
    prompt,
    max_tokens: budget,
    stream: !!options.stream,
  };
  if (options.system) body.system = options.system;
  if (options.temperature != null) body.temperature = options.temperature;
  const model = freewayModelOrAuto(options.model);
  if (model) body.model = model;

  const { signal, done } = withTimeout(timeoutFor(budget, options.timeoutMs), options.signal);
  const startedAt = Date.now();
  try {
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
        signal,
        cache: 'no-store',
      });
    } catch (e) {
      // A gateway that isn't running surfaces as a bare `TypeError: fetch failed`, which tells the
      // user nothing and isn't classifiable by the retry logic below (which keys on FreewayError).
      // Wrap it with the address we actually tried. `retryable: false` is deliberate — a refused
      // connection will not succeed on a retry, and the provider chain rotates past it anyway.
      const cause = e instanceof Error ? e.message : String(e);
      // A timeout aborts the fetch, and Node reports that as a DOMException whose message is the
      // abort REASON — our own "Freeway request timed out after Nms" string — not the word "abort".
      // Matching only on 'abort'/AbortError sent timeouts down the "is it running?" branch, which
      // told the user the gateway was down when it was simply slow. Match the reason text too.
      if ((e as Error)?.name === 'AbortError' || /abort|timed out/i.test(cause)) {
        throw new FreewayError(504, 'timeout', `Freeway did not respond in time — ${cause}`);
      }
      throw new FreewayError(
        503,
        'unreachable',
        `Freeway gateway is not reachable at ${base} — is it running? (${cause})`,
      );
    }
    if (!res.ok) throw await toFreewayError(res);

    const answer = options.stream
      ? await readAskStream(res, options.onDelta)
      : toAnswer((await res.json()) as Record<string, unknown>);

    if (!answer.text.trim()) {
      // Almost always a too-small budget on a reasoning model; the floor above makes it rare.
      throw new FreewayError(
        502,
        'empty_response',
        `Freeway returned empty text (model=${answer.modelUsed ?? 'unknown'}, stop=${answer.stopReason ?? '?'})`,
      );
    }

    // TRUNCATED MID-THOUGHT — reject it rather than hand back a scratchpad.
    //
    // The default model is a reasoning model whose thinking is billed against the same budget as
    // the answer. When it runs out MID-THINKING, `text` is the raw internal monologue, not an
    // answer, and `stop_reason` is `max_tokens`. Observed verbatim from a real cover-letter call:
    // "We need to write a cover letter for Integration Architect at Acme Health. Use resume detai…"
    // — 17KB of scratchpad, delivered to the user as their cover letter.
    //
    // A finished answer reports `end_turn`, so this is a reliable discriminator. Throwing marks the
    // attempt failed and lets `callWithProviders` rotate to the next provider, which is far better
    // than returning unusable text that looks like success.
    if (answer.stopReason === 'max_tokens') {
      throw new FreewayError(
        // 422, NOT 502. `retryable` is `status === 502`, and a truncated response is deterministic:
        // the same prompt with the same budget will run out of thinking room again. Marking it
        // retryable turned one slow failure into two — measured 277s on a single cover letter,
        // because each attempt costs 35-70s and neither could ever succeed.
        422,
        'truncated_response',
        `Freeway response hit the token cap before finishing (model=${answer.modelUsed ?? 'unknown'}, ` +
          `${answer.usage?.outputTokens ?? '?'} output tokens) — the text is incomplete reasoning, not an answer. ` +
          `Raise maxTokens for this call.`,
      );
    }
    logServed(answer, options.label, Date.now() - startedAt);
    return answer;
  } finally {
    done();
  }
}

/**
 * Read `/api/v1/ask` SSE. Every line is `data: <json>` of either
 * `{type:"delta", text}` or a single terminal `{type:"done", text, model_used, ...}`.
 * Note there is NO `[DONE]` sentinel on this endpoint (unlike /v1/chat/completions).
 */
async function readAskStream(res: Response, onDelta?: (delta: string) => void): Promise<FreewayAnswer> {
  if (!res.body) throw new FreewayError(502, 'stream_error', 'Freeway returned no stream body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let final: FreewayAnswer | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(json) as Record<string, unknown>;
      } catch {
        continue; // a partial/garbled frame is not worth failing the whole answer over
      }
      if (event.type === 'delta' && typeof event.text === 'string') {
        accumulated += event.text;
        onDelta?.(event.text);
      } else if (event.type === 'done') {
        final = toAnswer(event);
      } else if (event.type === 'error') {
        const err = event.error as { type?: string; message?: string } | undefined;
        throw new FreewayError(502, err?.type || 'stream_error', err?.message || 'Freeway stream reported an error');
      }
    }
  }
  if (final) return final.text.trim() ? final : { ...final, text: accumulated };
  // Stream ended without a `done` frame — keep whatever text we accumulated.
  return {
    text: accumulated,
    modelUsed: null,
    wasFallback: false,
    stopReason: null,
    usage: { inputTokens: null, outputTokens: null },
    toolCalls: [],
  };
}

/**
 * Send a prompt to Freeway and get the answer. Retries ONCE on 502 (every provider failed),
 * because Freeway has already exhausted its own internal failover by that point; 400/401/503
 * are never retried since they cannot succeed on a second attempt.
 */
export async function ask(prompt: string, options: AskOptions = {}): Promise<FreewayAnswer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_ON_502; attempt++) {
    try {
      return await askOnce(prompt, options);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof FreewayError && e.retryable;
      if (!retryable || attempt === RETRY_ON_502) break;
      console.warn(`[freeway] ${(e as Error).message.slice(0, 160)} — retrying once in ${RETRY_BACKOFF_MS}ms`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Freeway request failed');
}

/** Convenience for the provider chain in `llm.ts`, which only needs the text. */
export async function askText(prompt: string, options: AskOptions = {}): Promise<string> {
  return (await ask(prompt, options)).text;
}
