import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

interface ProviderRow {
  id: number;
  kind: string;
  display_name: string;
  model: string;
  api_key: string | null;
  base_url: string | null;
  is_active: number;
  is_creative: number;
  created_at: string;
}

// Keep in sync with PROVIDER_KINDS in src/lib/db.ts (the table's CHECK) and ProviderKind in src/lib/llm.ts.
const VALID_KINDS = ['gemini', 'openai', 'anthropic', 'openai-compatible', 'ollama', 'freeway'];

function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${'•'.repeat(Math.max(8, key.length - 4))}${key.slice(-4)}`;
}

function rowToPublic(r: ProviderRow) {
  return {
    id: r.id,
    kind: r.kind,
    display_name: r.display_name,
    model: r.model,
    api_key_masked: maskKey(r.api_key),
    has_api_key: !!r.api_key,
    base_url: r.base_url,
    is_active: !!r.is_active,
    is_creative: !!r.is_creative,
    created_at: r.created_at,
  };
}

// GET /api/providers — list all configured providers
export async function GET() {
  try {
    const rows = db.prepare('SELECT * FROM llm_providers ORDER BY is_active DESC, id ASC').all() as ProviderRow[];
    return NextResponse.json({ providers: rows.map(rowToPublic) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}

// POST /api/providers — create
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { kind, display_name, model, api_key, base_url } = body;
    if (!kind || !VALID_KINDS.includes(kind)) {
      return NextResponse.json({ error: 'Invalid kind' }, { status: 400 });
    }
    if (!display_name || !model) {
      return NextResponse.json({ error: 'display_name and model are required' }, { status: 400 });
    }
    // openai-compatible needs base_url. Others optionally.
    if (kind === 'openai-compatible' && !base_url) {
      return NextResponse.json({ error: 'base_url required for openai-compatible' }, { status: 400 });
    }
    // Freeway runs on localhost, so its URL is a sensible default rather than a required field.
    const resolvedBaseUrl =
      kind === 'freeway' ? base_url || process.env.FREEWAY_BASE_URL || 'http://localhost:8092' : base_url;
    // Ollama needs no key. Freeway's is optional: if FREEWAY_API_KEY is already in .env.local
    // the row inherits it at call time (src/lib/freeway.ts falls back to env), so the user isn't
    // made to paste the same key twice. Supplying one here overrides the env value for this row.
    const keyOptional = kind === 'ollama' || (kind === 'freeway' && !!process.env.FREEWAY_API_KEY);
    if (!keyOptional && !api_key) {
      return NextResponse.json(
        {
          error:
            kind === 'freeway'
              ? 'api_key required — paste a Freeway key (admin → Monitor → API Keys) or set FREEWAY_API_KEY in .env.local'
              : 'api_key required',
        },
        { status: 400 },
      );
    }
    const result = db
      .prepare(
        'INSERT INTO llm_providers (kind, display_name, model, api_key, base_url) VALUES (?, ?, ?, ?, ?)'
      )
      .run(kind, display_name, model, api_key || null, resolvedBaseUrl || null);
    const row = db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(result.lastInsertRowid) as ProviderRow;
    return NextResponse.json({ provider: rowToPublic(row) });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}
