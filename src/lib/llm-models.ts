import db from './db';

export interface ModelSpec {
  id: string;
  name: string;
  contextWindow: string;
  hitsLimitDaily: number;    // Requests Per Day (RPD / Hits)
  rpmLimit: number;           // Requests Per Minute (RPM)
  tpmLimit: number;           // Tokens Per Minute (TPM)
  isRecommended?: boolean;
}

export interface LLMUsageStats {
  hitsToday: number;
  tokensToday: number;
  hitsRemaining: number;
  tokensRemaining: number;
  hitsUsagePercent: number;
  tokensUsagePercent: number;
  lastUsedAt: string | null;
}

export const PROVIDER_MODEL_REGISTRY: Record<string, ModelSpec[]> = {
  gemini: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 15, tpmLimit: 1000000, isRecommended: true },
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 15, tpmLimit: 1000000 },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 15, tpmLimit: 1000000 },
    { id: 'gemini-3.6-pro', name: 'Gemini 3.6 Pro', contextWindow: '2.0M Tokens', hitsLimitDaily: 50, rpmLimit: 2, tpmLimit: 32000 },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 15, tpmLimit: 1000000 },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 30, tpmLimit: 1000000 },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: '2.0M Tokens', hitsLimitDaily: 50, rpmLimit: 2, tpmLimit: 32000 },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 15, tpmLimit: 1000000 },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 30, tpmLimit: 1000000 },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 15, tpmLimit: 1000000 },
    { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 30, tpmLimit: 1000000 },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextWindow: '2.0M Tokens', hitsLimitDaily: 50, rpmLimit: 2, tpmLimit: 32000 },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextWindow: '1.0M Tokens', hitsLimitDaily: 1500, rpmLimit: 15, tpmLimit: 1000000 },
  ],
  freeway: [
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron-3 Super 120B (Free)', contextWindow: '128K Tokens', hitsLimitDaily: 1000, rpmLimit: 40, tpmLimit: 100000, isRecommended: true },
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct', contextWindow: '128K Tokens', hitsLimitDaily: 1000, rpmLimit: 30, tpmLimit: 100000 },
    { id: 'mistralai/mixtral-8x22b-instruct', name: 'Mixtral 8x22B Instruct', contextWindow: '64K Tokens', hitsLimitDaily: 1000, rpmLimit: 30, tpmLimit: 100000 },
    { id: 'deepseek-ai/deepseek-r1', name: 'DeepSeek R1', contextWindow: '64K Tokens', hitsLimitDaily: 500, rpmLimit: 20, tpmLimit: 64000 },
    { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B Instruct', contextWindow: '64K Tokens', hitsLimitDaily: 1000, rpmLimit: 30, tpmLimit: 100000 },
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: '128K Tokens', hitsLimitDaily: 10000, rpmLimit: 500, tpmLimit: 200000, isRecommended: true },
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: '128K Tokens', hitsLimitDaily: 5000, rpmLimit: 500, tpmLimit: 30000 },
    { id: 'o3-mini', name: 'o3-mini Reasoning', contextWindow: '200K Tokens', hitsLimitDaily: 5000, rpmLimit: 500, tpmLimit: 100000 },
    { id: 'o1-mini', name: 'o1-mini Reasoning', contextWindow: '128K Tokens', hitsLimitDaily: 5000, rpmLimit: 500, tpmLimit: 100000 },
  ],
  anthropic: [
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: '200K Tokens', hitsLimitDaily: 5000, rpmLimit: 50, tpmLimit: 50000, isRecommended: true },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: '200K Tokens', hitsLimitDaily: 1000, rpmLimit: 50, tpmLimit: 40000 },
    { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', contextWindow: '200K Tokens', hitsLimitDaily: 1000, rpmLimit: 50, tpmLimit: 40000 },
  ],
  'openai-compatible': [
    { id: 'llama-3.3-70b-versatile', name: 'Groq Llama 3.3 70B', contextWindow: '128K Tokens', hitsLimitDaily: 14400, rpmLimit: 30, tpmLimit: 100000, isRecommended: true },
    { id: 'llama-3.1-8b-instant', name: 'Groq Llama 3.1 8B', contextWindow: '128K Tokens', hitsLimitDaily: 14400, rpmLimit: 30, tpmLimit: 30000 },
    { id: 'mixtral-8x7b-32768', name: 'Groq Mixtral 8x7B', contextWindow: '32K Tokens', hitsLimitDaily: 14400, rpmLimit: 30, tpmLimit: 50000 },
    { id: 'deepseek-r1-distill-llama-70b', name: 'Groq DeepSeek R1 70B', contextWindow: '128K Tokens', hitsLimitDaily: 14400, rpmLimit: 30, tpmLimit: 100000 },
    { id: 'llama-3.3-70b', name: 'Cerebras Llama 3.3 70B', contextWindow: '128K Tokens', hitsLimitDaily: 14400, rpmLimit: 30, tpmLimit: 100000 },
    { id: 'mistral-small-latest', name: 'Mistral Small', contextWindow: '32K Tokens', hitsLimitDaily: 10000, rpmLimit: 60, tpmLimit: 100000 },
  ],
};

export function getAvailableModelsForKind(kind: string, currentModel?: string): ModelSpec[] {
  const models = [...(PROVIDER_MODEL_REGISTRY[kind] || [])];
  if (currentModel && !models.some((m) => m.id === currentModel)) {
    models.unshift({
      id: currentModel,
      name: currentModel,
      contextWindow: '128K Tokens',
      hitsLimitDaily: 1500,
      rpmLimit: 30,
      tpmLimit: 1000000,
    });
  }
  return models;
}

export function recordLLMUsage(providerKind: string, model: string, tokensUsed = 150, providerId?: number) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO llm_usage (provider_id, provider_kind, model, date, hits, tokens, last_used_at)
      VALUES (?, ?, ?, ?, 1, ?, datetime('now'))
      ON CONFLICT(provider_kind, model, date) DO UPDATE SET
        hits = hits + 1,
        tokens = tokens + excluded.tokens,
        provider_id = COALESCE(excluded.provider_id, llm_usage.provider_id),
        last_used_at = datetime('now')
    `).run(providerId || null, providerKind, model, today, tokensUsed);
  } catch {
    // Ignore logging errors so LLM calls never fail due to usage tracking
  }
}

export function getLLMUsageStats(providerKind: string, model: string, providerId?: number): LLMUsageStats {
  const today = new Date().toISOString().slice(0, 10);
  let hitsToday = 0;
  let tokensToday = 0;
  let lastUsedAt: string | null = null;

  try {
    let row: { hits: number; tokens: number; last_used_at: string } | undefined;
    if (providerId) {
      row = db.prepare(`
        SELECT SUM(hits) as hits, SUM(tokens) as tokens, MAX(last_used_at) as last_used_at
        FROM llm_usage
        WHERE (provider_id = ? OR provider_kind = ?) AND date = ?
      `).get(providerId, providerKind, today) as { hits: number; tokens: number; last_used_at: string } | undefined;
    } else {
      row = db.prepare(`
        SELECT SUM(hits) as hits, SUM(tokens) as tokens, MAX(last_used_at) as last_used_at
        FROM llm_usage
        WHERE provider_kind = ? AND date = ?
      `).get(providerKind, today) as { hits: number; tokens: number; last_used_at: string } | undefined;
    }

    if (row && row.hits) {
      hitsToday = Number(row.hits) || 0;
      tokensToday = Number(row.tokens) || 0;
      lastUsedAt = row.last_used_at || null;
    }
  } catch (e) {
    console.warn('[llm-usage] getLLMUsageStats error:', e);
  }

  const models = getAvailableModelsForKind(providerKind, model);
  const spec = models.find((m) => m.id === model) || {
    id: model,
    name: model,
    contextWindow: '128K Tokens',
    hitsLimitDaily: 1500,
    rpmLimit: 30,
    tpmLimit: 1000000,
  };

  const hitsRemaining = Math.max(0, spec.hitsLimitDaily - hitsToday);
  const tokensRemaining = Math.max(0, spec.tpmLimit - tokensToday);
  const hitsUsagePercent = Math.min(100, Math.round((hitsToday / spec.hitsLimitDaily) * 100));
  const tokensUsagePercent = Math.min(100, Math.round((tokensToday / spec.tpmLimit) * 100));

  return {
    hitsToday,
    tokensToday,
    hitsRemaining,
    tokensRemaining,
    hitsUsagePercent,
    tokensUsagePercent,
    lastUsedAt,
  };
}

