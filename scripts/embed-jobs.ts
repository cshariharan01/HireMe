import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
// Provider-aware embedder (Ollama by default, or a cloud provider via EMBEDDING_PROVIDER).
// embeddings.ts is pure (no DB import), so importing it here has no schema side-effects.
import { generateEmbeddings, generateEmbedding, embeddingToBlob, getEmbeddingInfo } from '../src/lib/embeddings';
import { assertEmbeddingConsistent, recordEmbeddingSignature } from '../src/lib/embedding-signature';

const db = new Database(path.join(process.cwd(), 'data', 'hiresignal.db'));
sqliteVec.load(db);

interface JobRow {
  id: number;
  title: string;
  company: string;
  description: string;
}

const jobText = (j: JobRow) => `${j.title} ${j.company} ${(j.description || '').slice(0, 2000)}`.slice(0, 6000);

async function main() {
  // Embed all pending by default (bounded by EMBED_LIMIT). Batching makes clearing the whole
  // backlog in one run feasible, so the default is high enough to avoid a leftover tail.
  const EMBED_LIMIT = parseInt(process.env.EMBED_LIMIT || '20000', 10) || 20000;
  const BATCH = parseInt(process.env.EMBED_BATCH || '24', 10) || 24;
  // ACTIVE first, NEWEST first. Two reasons this ordering matters:
  //   1. An expired job can never appear in the match list, so embedding one is pure waste. It
  //      still gets embedded eventually (a later prune can resurrect it), just last.
  //   2. Embedding is the slowest step in the pipeline on CPU Ollama — measured ~100s per batch of
  //      24 on 6k-char descriptions, so a 5,000-job backlog is hours. Ordering by recency means an
  //      interrupted or partial run has still embedded the jobs most worth matching, instead of a
  //      random slice.
  const jobs = db.prepare(
    `SELECT id, title, company, description FROM job_postings
     WHERE embedding IS NULL
     ORDER BY (expired_at IS NOT NULL) ASC,
              COALESCE(posted_at, last_seen_at, ingested_at) DESC
     LIMIT ?`
  ).all(EMBED_LIMIT) as JobRow[];

  if (jobs.length === 0) {
    console.log('No jobs need embedding.');
    db.close();
    return;
  }

  // Guard: refuse to embed into a corpus that used a different provider (would corrupt matching).
  try {
    assertEmbeddingConsistent(db);
  } catch (e) {
    console.error(`\n✗ ${e instanceof Error ? e.message : e}\n`);
    db.close();
    process.exit(1);
  }

  const info = getEmbeddingInfo();
  console.log(`Embedding ${jobs.length} jobs via ${info.provider}/${info.model} (batch size ${BATCH})...`);
  const updateStmt = db.prepare('UPDATE job_postings SET embedding = ? WHERE id = ?');
  let count = 0;
  let useBatch = true;

  for (let i = 0; i < jobs.length; i += BATCH) {
    const chunk = jobs.slice(i, i + BATCH);
    try {
      if (!useBatch) throw new Error('batch disabled');
      const embs = await generateEmbeddings(chunk.map(jobText));
      const write = db.transaction(() => {
        chunk.forEach((j, k) => { if (embs[k]) updateStmt.run(embeddingToBlob(embs[k]), j.id); });
      });
      write();
      count += chunk.length;
    } catch (err) {
      // Fall back to per-item embedding for this chunk (and all subsequent chunks).
      if (useBatch) console.error(`  Batch embedding failed (${(err as Error).message.slice(0, 100)}) — using single-item mode`);
      useBatch = false;
      for (const j of chunk) {
        try { updateStmt.run(embeddingToBlob(await generateEmbedding(jobText(j))), j.id); count++; }
        catch (e) { console.error(`  ✗ Job ${j.id}: ${(e as Error).message}`); }
      }
    }
    console.log(`  Embedded ${Math.min(i + BATCH, jobs.length)}/${jobs.length} jobs`);
  }

  if (count > 0) recordEmbeddingSignature(db); // first embed establishes the corpus's embedding space
  console.log(`Embedded ${count} jobs total.`);
  db.close();
}

main();
