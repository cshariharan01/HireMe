import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

interface ProviderRow {
  kind: string;
  model: string;
  api_key: string | null;
  base_url: string | null;
}

// POST /api/providers/[id]/test — sends a minimal "ping" to verify the credentials work.
// Doesn't activate the provider. Returns ok:true with the model's response, or ok:false with the error.
export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id);
    const row = db.prepare('SELECT kind, model, api_key, base_url FROM llm_providers WHERE id = ?').get(id) as ProviderRow | undefined;
    if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });

    const ping = 'Reply with the single word: PONG';
    if (row.kind === 'gemini') {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      if (!row.api_key) return NextResponse.json({ ok: false, error: 'Missing api_key' });
      const client = new GoogleGenerativeAI(row.api_key);
      const model = client.getGenerativeModel({ model: row.model, generationConfig: { maxOutputTokens: 1024 } });
      const result = await model.generateContent(ping);
      const text = result.response.text() || '';
      return NextResponse.json({ ok: true, response: text.trim().slice(0, 100) });
    }
    if (row.kind === 'anthropic') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      if (!row.api_key) return NextResponse.json({ ok: false, error: 'Missing api_key' });
      const client = new Anthropic({ apiKey: row.api_key });
      const result = await client.messages.create({
        model: row.model,
        max_tokens: 32,
        messages: [{ role: 'user', content: ping }],
      });
      const block = result.content.find((b) => b.type === 'text');
      const text = block && block.type === 'text' ? block.text : '';
      return NextResponse.json({ ok: true, response: text.trim().slice(0, 100) });
    }
    if (row.kind === 'openai' || row.kind === 'openai-compatible') {
      const baseUrl = row.base_url || (row.kind === 'openai' ? 'https://api.openai.com/v1' : null);
      if (!baseUrl) return NextResponse.json({ ok: false, error: 'Missing base_url' });
      if (!row.api_key) return NextResponse.json({ ok: false, error: 'Missing api_key' });
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${row.api_key}` },
        body: JSON.stringify({
          model: row.model,
          messages: [{ role: 'user', content: ping }],
          // 256, not 32: reasoning models (e.g. anything Freeway routes to by default) spend
          // this same budget on their thinking, and a 32-token cap returns reasoning — or
          // nothing at all — instead of the answer. It's a cap, so cheap models are unaffected.
          max_tokens: 256,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return NextResponse.json({ ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` });
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      return NextResponse.json({ ok: true, response: text.trim().slice(0, 100) });
    }
    if (row.kind === 'freeway') {
      // Freeway is a gateway, so a failing ping is ambiguous: gateway down vs. bad key vs. no
      // provider with quota. Check /health (unauthenticated) first so the message says which.
      const { ask, freewayHealth, normalizeFreewayBase } = await import('@/lib/freeway');
      const base = normalizeFreewayBase(row.base_url) || undefined;
      // Check the URL THIS provider is configured with, not the env default.
      if (!(await freewayHealth(5000, row.base_url))) {
        return NextResponse.json({ ok: false, error: `Freeway is not responding at ${base || 'its configured URL'} — is it running?` });
      }
      try {
        // 512 tokens, not 32: Freeway's default model is a reasoning model that spends the same
        // budget thinking, and a small cap returns its reasoning (or nothing) instead of a reply.
        const answer = await ask(ping, { apiKey: row.api_key, baseUrl: row.base_url, maxTokens: 512, label: 'provider-test' });
        return NextResponse.json({
          ok: true,
          response: `${answer.text.trim().slice(0, 60)} — via ${answer.modelUsed ?? 'unknown'}${answer.wasFallback ? ' (fallback)' : ''}`,
        });
      } catch (e) {
        return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Freeway call failed' });
      }
    }
    if (row.kind === 'ollama') {
      const baseUrl = row.base_url || 'http://127.0.0.1:11434';
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: row.model, prompt: ping, stream: false }),
      });
      if (!res.ok) return NextResponse.json({ ok: false, error: `HTTP ${res.status}` });
      const data = await res.json();
      return NextResponse.json({ ok: true, response: (data.response || '').trim().slice(0, 100) });
    }
    return NextResponse.json({ ok: false, error: 'Unknown kind' });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Failed' });
  }
}
