import type BetterSqlite3 from 'better-sqlite3';
import { getEmbeddingSignature } from './embeddings';

// Guards the "one DB = one embedding space" invariant. Every embedding in a database must be
// produced by the same provider:model, or cosine distance across them is meaningless (garbage
// matches — silent, and especially nasty when two providers share a dimension, e.g. nomic 768
// vs gemini 768). We store the corpus's signature once (first embed) and refuse to embed into
// it with a different signature. Switching providers is a deliberate re-embed (see .env.example).
//
// Functions take the db handle as a param so both the Next app (its shared handle) and the
// standalone `npm run embed` script (its own handle) can use them without import side-effects.

type DB = BetterSqlite3.Database;
const KEY = 'embedding_signature';

function ensureTable(db: DB): void {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)');
  } catch { /* best-effort; created in db.ts for the app handle */ }
}

/** The signature the DB's existing embeddings were produced with, or null if nothing embedded yet. */
export function readEmbeddingSignature(db: DB): string | null {
  ensureTable(db);
  try {
    const r = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(KEY) as { value: string } | undefined;
    return r?.value ?? null;
  } catch {
    return null;
  }
}

export function embeddingMismatchMessage(stored: string, current: string): string {
  const storedProvider = stored.split(':')[0];
  return (
    `Embedding provider mismatch. Your data was embedded with "${stored}", but EMBEDDING_PROVIDER ` +
    `is now "${current}". Adding embeddings with a different model would corrupt matching. ` +
    `Fix one of two ways: (a) set EMBEDDING_PROVIDER back to "${storedProvider}", or ` +
    `(b) re-embed everything with the new provider — run \`npm run db:reset\`, then re-add your ` +
    `résumé and run a full sync. See .env.example.`
  );
}

/**
 * Call BEFORE creating any new embedding (résumé upload, job embed). Throws a clear, actionable
 * error if the corpus was embedded with a different provider — turning silent corruption into a
 * safe stop. No-op when the DB has no embeddings yet (signature unset).
 */
export function assertEmbeddingConsistent(db: DB): void {
  const stored = readEmbeddingSignature(db);
  if (!stored) return;
  const current = getEmbeddingSignature();
  if (stored !== current) throw new Error(embeddingMismatchMessage(stored, current));
}

/**
 * Call AFTER writing an embedding. Records the corpus signature on the first embed. (By the time
 * this runs, assertEmbeddingConsistent has already guaranteed a match or an empty corpus.)
 */
export function recordEmbeddingSignature(db: DB): void {
  ensureTable(db);
  const current = getEmbeddingSignature();
  const stored = readEmbeddingSignature(db);
  if (stored === current) return;
  if (stored && stored !== current) throw new Error(embeddingMismatchMessage(stored, current));
  db.prepare(
    'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(KEY, current);
}
