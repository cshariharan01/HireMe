// test-freeway.ts — prove the Freeway integration against the REAL gateway. No mocks:
// the whole point is to verify the live wiring (see also `npm run test-apply`, same spirit).
//
// Checks, in order:
//   1. GET /health              — is the gateway up? (unauthenticated)
//   2. ask() non-streaming      — one real completion through src/lib/freeway.ts
//   3. ask() streaming          — deltas arrive, and the terminal `done` frame is parsed
//   4. bad key                  — asserts a 401 FreewayError, i.e. auth is actually enforced
//
// Costs 2 real requests against the free tier (~50/day), so don't loop this.
//
// Run: npx ts-node scripts/test-freeway.ts

import './shared/env';
import { ask, freewayHealth, freewayBaseUrl, isFreewayEnabled, FreewayError } from '../src/lib/freeway';

let failures = 0;

function pass(label: string, detail = ''): void {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string): void {
  failures++;
  console.error(`  FAIL  ${label} — ${detail}`);
}

async function main(): Promise<void> {
  console.log(`\nFreeway integration smoke test → ${freewayBaseUrl()}\n`);

  if (!isFreewayEnabled()) {
    console.error('FREEWAY_API_KEY is not set (.env.local) — nothing to test. See .env.example.');
    process.exitCode = 1;
    return;
  }

  // 1. Health — the gateway needs ~30-50s after boot to discover models, so a failure here
  //    usually means "not started" or "still warming up", not "broken".
  const healthy = await freewayHealth();
  if (healthy) pass('health', 'status=healthy');
  else {
    fail('health', `no healthy response from ${freewayBaseUrl()}/health — is Freeway running?`);
    console.error('\nSkipping the remaining checks: they would all fail for the same reason.');
    process.exitCode = 1;
    return;
  }

  // 2. Non-streaming completion.
  try {
    const answer = await ask('Reply with exactly: OK', { maxTokens: 512, label: 'smoke' });
    const ok = /\bOK\b/i.test(answer.text);
    const detail = `model=${answer.modelUsed} fallback=${answer.wasFallback} text=${JSON.stringify(answer.text.trim().slice(0, 60))}`;
    if (ok) pass('non-streaming ask', detail);
    else fail('non-streaming ask', `expected "OK" in the reply — ${detail}`);
  } catch (e) {
    fail('non-streaming ask', e instanceof Error ? e.message : String(e));
  }

  // 3. Streaming completion — assert we saw at least one delta AND a complete final text.
  try {
    let deltas = 0;
    const answer = await ask('Count from 1 to 5, separated by spaces. No other text.', {
      maxTokens: 512,
      stream: true,
      label: 'smoke-stream',
      onDelta: () => {
        deltas++;
      },
    });
    const detail = `${deltas} delta(s), model=${answer.modelUsed}, text=${JSON.stringify(answer.text.trim().slice(0, 60))}`;
    if (deltas > 0 && answer.text.trim()) pass('streaming ask', detail);
    else fail('streaming ask', `expected >0 deltas and non-empty text — ${detail}`);
  } catch (e) {
    fail('streaming ask', e instanceof Error ? e.message : String(e));
  }

  // 4. Auth is enforced — a deliberately wrong key must raise a 401, not fall through.
  //    Costs no provider quota: Freeway rejects it before routing.
  const realKey = process.env.FREEWAY_API_KEY;
  process.env.FREEWAY_API_KEY = 'fw_deliberately_invalid_key';
  try {
    await ask('This must never reach a provider.', { maxTokens: 512, label: 'smoke-badkey' });
    fail('bad key → 401', 'the call SUCCEEDED with an invalid key — auth is not being enforced');
  } catch (e) {
    if (e instanceof FreewayError && e.status === 401) pass('bad key → 401', `retryable=${e.retryable}`);
    else fail('bad key → 401', `expected a 401 FreewayError, got: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    process.env.FREEWAY_API_KEY = realKey;
  }

  console.log(failures === 0 ? '\nAll Freeway checks passed.\n' : `\n${failures} Freeway check(s) FAILED.\n`);
  // process.exitCode, not process.exit(): forcing exit while a socket handle is still closing
  // trips a libuv assertion on Windows.
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('Unexpected failure:', e);
  process.exitCode = 1;
});
