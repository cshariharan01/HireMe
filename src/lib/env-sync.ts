import fs from 'fs';
import path from 'path';
import db from './db';

/**
 * Synchronizes the active LLM provider configuration from SQLite to the local .env file.
 * This guarantees that users who configure their API key strictly through the application
 * settings page never need to manually copy .env.example or edit .env in a terminal.
 */
export function syncEnvFromActiveProvider(): void {
  try {
    const activeRow = db
      .prepare('SELECT kind, api_key, model FROM llm_providers WHERE is_active = 1 LIMIT 1')
      .get() as { kind: string; api_key: string | null; model: string | null } | undefined;

    const geminiRow = db
      .prepare("SELECT api_key FROM llm_providers WHERE kind = 'gemini' AND api_key IS NOT NULL ORDER BY is_active DESC, id DESC LIMIT 1")
      .get() as { api_key: string } | undefined;

    const geminiKey = geminiRow?.api_key || (activeRow?.kind === 'gemini' ? activeRow.api_key : null);

    // Keep active Node process environment in sync
    if (geminiKey) {
      process.env.GEMINI_API_KEY = geminiKey;
    }
    if (!process.env.EMBEDDING_PROVIDER || process.env.EMBEDDING_PROVIDER === 'ollama') {
      process.env.EMBEDDING_PROVIDER = 'gemini';
    }

    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const updates: Record<string, string> = {};
    if (geminiKey) {
      updates['GEMINI_API_KEY'] = geminiKey;
    }
    if (!envContent.includes('EMBEDDING_PROVIDER=')) {
      updates['EMBEDDING_PROVIDER'] = 'gemini';
    }

    if (Object.keys(updates).length > 0) {
      let lines = envContent ? envContent.split(/\r?\n/) : [];
      for (const [key, val] of Object.entries(updates)) {
        const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
        if (idx >= 0) {
          lines[idx] = `${key}=${val}`;
        } else {
          lines.push(`${key}=${val}`);
        }
      }
      fs.writeFileSync(envPath, lines.join('\n').trim() + '\n', 'utf8');
    }
  } catch (err) {
    console.warn('[env-sync] Note: could not synchronize .env file:', err);
  }
}
