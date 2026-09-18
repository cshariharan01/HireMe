import { describe, it, expect, vi, afterEach } from 'vitest';
import { ask, FreewayError } from '@/lib/freeway';

/**
 * REGRESSION: a response truncated mid-thought must be rejected, not returned as an answer.
 *
 * Freeway's default model is a REASONING model that bills its thinking against the same token
 * budget as the answer. When it runs out mid-thinking, `text` is the raw internal monologue and
 * `stop_reason` is `max_tokens`. Observed verbatim on a real cover-letter call: 17KB beginning
 * "We need to write a cover letter for Integration Architect at Acme Health. Use resume detai…" —
 * delivered to the user as their cover letter.
 *
 * A finished answer reports `end_turn`, which makes this a reliable discriminator. Rejecting lets
 * the provider chain rotate instead of surfacing unusable text that looks like success.
 */
const KEY = 'fw_test';

function mockAsk(payload: Record<string, unknown>, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Freeway rejects truncated reasoning', () => {
  it('throws when stop_reason is max_tokens, even though text is non-empty', async () => {
    mockAsk({
      text: 'We need to write a cover letter for Integration Architect at Acme Health. Use resume detai',
      model_used: 'nvidia/nemotron-3-super-120b-a12b:free',
      was_fallback: false,
      stop_reason: 'max_tokens',
      usage: { input_tokens: 632, output_tokens: 4096 },
    });

    await expect(ask('write a cover letter', { apiKey: KEY, maxTokens: 4096 })).rejects.toThrow(
      /token cap|incomplete reasoning/i,
    );
  });

  it('the rejection is a FreewayError, so the chain treats it as a provider failure', async () => {
    mockAsk({
      text: 'thinking...',
      model_used: 'm',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    await expect(ask('x', { apiKey: KEY, maxTokens: 512 })).rejects.toBeInstanceOf(FreewayError);
  });

  it('accepts a completed answer (end_turn)', async () => {
    mockAsk({
      text: 'Dear hiring team, I am writing to apply.',
      model_used: 'nvidia/nemotron-3-super-120b-a12b:free',
      was_fallback: false,
      stop_reason: 'end_turn',
      usage: { input_tokens: 34, output_tokens: 97 },
    });

    const answer = await ask('write a cover letter', { apiKey: KEY, maxTokens: 4096 });
    expect(answer.text).toMatch(/Dear hiring team/);
    expect(answer.stopReason).toBe('end_turn');
  });

  it('still rejects a genuinely empty response', async () => {
    mockAsk({ text: '   ', model_used: 'm', stop_reason: 'end_turn', usage: {} });
    await expect(ask('x', { apiKey: KEY, maxTokens: 512 })).rejects.toThrow(/empty text/i);
  });
});

describe('FreewayError survives subclassing (instanceof)', () => {
  /**
   * `FreewayError`'s constructor calls `Object.setPrototypeOf`. tsconfig now targets ES2017 so this
   * is belt-and-braces, but at ES5 (the default when no target is set — which WAS the case)
   * subclassing a built-in Error loses the prototype and `instanceof` silently returns false,
   * sending every error down the "not retryable" branch.
   */
  it('is an instance of both FreewayError and Error', () => {
    const e = new FreewayError(502, 'x', 'boom');
    expect(e).toBeInstanceOf(FreewayError);
    expect(e).toBeInstanceOf(Error);
  });
});
