# Using Freeway with HireSignal (optional)

**Freeway** is a local, OpenAI-compatible gateway that routes requests across
~20 free/free-tier LLM providers with **quota-aware routing, multi-key rotation, automatic
fallback, and request auto-fit**. Pointing HireSignal's **chat** at Freeway makes daily/token
limits a non-issue — when one provider rate-limits, Freeway transparently routes to another.

**Freeway is optional.** HireSignal runs fine without it (a single provider key, or Ollama).
You do **not** have to install both — Freeway is only for people who want bulletproof quota
handling. HireSignal talks to it as a generic `openai-compatible` provider, so it never *depends*
on Freeway.

## What Freeway does / doesn't cover

| HireSignal traffic | Through Freeway? |
|---|---|
| **Chat** — job evaluation, cover letters, résumé variants, company research | ✅ Yes — Freeway exposes `/v1/chat/completions` |
| **Embeddings** — the matching engine | ❌ No — Freeway has no `/v1/embeddings` endpoint (it's a chat/coding gateway) |

So: **chat → Freeway; embeddings → Ollama (default, free, no quota) or a direct cloud embedding key.**

## Setup

1. **Start Freeway** (see its own docs): `freeway` → admin UI at `http://localhost:8082/admin`.
   Add a provider key on its **Providers** page and pick a model on **Models**.

2. **Point HireSignal's chat at Freeway.** In HireSignal → **Settings → Add provider**:
   - **Kind:** `openai-compatible`
   - **Base URL:** `http://localhost:8082/v1`  *(confirm the host/port from Freeway's startup log or admin UI)*
   - **Model:** a model id Freeway lists as ready (e.g. what its Models page shows)
   - **API key:** any non-empty placeholder if Freeway doesn't require one for local calls
   - Click **Use** to make it the active provider.

   HireSignal's chat now flows through Freeway, which handles routing/quota/fallback.

3. **Leave embeddings on Ollama** (default) — nothing to change. Ollama is local and has no
   quota, so the "what if the daily limit is exceeded" problem doesn't apply to matching.
   (If you can't run Ollama, set a direct cloud embedding key instead — see `.env.example`
   `EMBEDDING_PROVIDER`. That path is *not* proxied by Freeway.)

## Why this split

- Embeddings must all share one model/space (see `.env.example`), and Freeway routes across many
  models — so it's the wrong layer for embeddings even if it added the endpoint.
- Keeping embeddings local (Ollama) means matching keeps working even when every cloud chat key
  is exhausted.
