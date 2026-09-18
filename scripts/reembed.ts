// In-place re-embed. Use this to SWITCH embedding provider (or model) without db:reset — it
// regenerates ONLY the vectors (all jobs + every résumé + the active profile, from the text
// already stored in the DB) with the CURRENT EMBEDDING_PROVIDER, and preserves everything else
// (applications, tracker, résumé files/metadata, evaluations, briefs). Then it records the new
// embedding signature so the mismatch guard is satisfied.
//
//   npm run reembed          # do it
//   npm run reembed -- --dry # preview counts, write nothing
//
// It clears match_cache so matches recompute on next app load.
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import { generateEmbeddings, generateEmbedding, embeddingToBlob, getEmbeddingInfo } from '../src/lib/embeddings';
import { readEmbeddingSignature, recordEmbeddingSignature } from '../src/lib/embedding-signature';

const DRY = process.argv.includes('--dry') || process.env.DRY === '1';

const db = new Database(path.join(process.cwd(), 'data', 'hiresignal.db'));
sqliteVec.load(db);

interface JobRow { id: number; title: string; company: string; description: string }
interface ResumeRow { id: number; raw_text: string | null }

const jobText = (t: string, c: string, d: string) => `${t} ${c} ${(d || '').slice(0, 2000)}`.slice(0, 6000);

async function main() {
  const info = getEmbeddingInfo();
  const target = `${info.provider}:${info.model}`;
  const current = readEmbeddingSignature(db);
  const jobCount = (db.prepare('SELECT COUNT(*) n FROM job_postings').get() as { n: number }).n;
  const resumeCount = (() => { try { return (db.prepare('SELECT COUNT(*) n FROM resumes WHERE raw_text IS NOT NULL').get() as { n: number }).n; } catch { return 0; } })();

  console.log(`\n== In-place re-embed ==`);
  console.log(`  Current corpus signature : ${current ?? '(none)'}`);
  console.log(`  Re-embedding with        : ${target}`);
  console.log(`  Jobs to embed            : ${jobCount}`);
  console.log(`  Résumés to embed         : ${resumeCount} (+ active profile)`);
  console.log(`  Preserved                : applications, tracker, résumé files, evaluations, briefs`);
  if (DRY) { console.log('\n[--dry] No changes written.\n'); db.close(); return; }
  console.log('');

  // 1. Invalidate old state: signature (so the guard won't block) + match cache (old vectors).
  db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("DELETE FROM app_meta WHERE key = 'embedding_signature'").run();
  try { db.prepare('DELETE FROM match_cache').run(); } catch { /* table may not exist */ }

  // 2. Clear existing vectors.
  db.prepare('UPDATE job_postings SET embedding = NULL').run();
  db.prepare('UPDATE my_profile SET embedding = NULL').run();
  try { db.prepare('UPDATE resumes SET embedding = NULL').run(); } catch { /* table may not exist */ }

  // 3. Re-embed jobs (batched, with single-item fallback).
  const BATCH = parseInt(process.env.EMBED_BATCH || '24', 10) || 24;
  const jobs = db.prepare('SELECT id, title, company, description FROM job_postings').all() as JobRow[];
  const updJob = db.prepare('UPDATE job_postings SET embedding = ? WHERE id = ?');
  let count = 0;
  let useBatch = true;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const chunk = jobs.slice(i, i + BATCH);
    try {
      if (!useBatch) throw new Error('batch disabled');
      const embs = await generateEmbeddings(chunk.map((j) => jobText(j.title, j.company, j.description)));
      const write = db.transaction(() => { chunk.forEach((j, k) => { if (embs[k]) updJob.run(embeddingToBlob(embs[k]), j.id); }); });
      write();
      count += chunk.length;
    } catch (err) {
      if (useBatch) console.error(`  batch failed (${(err as Error).message.slice(0, 90)}) — single-item mode`);
      useBatch = false;
      for (const j of chunk) {
        try { updJob.run(embeddingToBlob(await generateEmbedding(jobText(j.title, j.company, j.description))), j.id); count++; }
        catch (e) { console.error(`  ✗ job ${j.id}: ${(e as Error).message}`); }
      }
    }
    console.log(`  jobs ${Math.min(i + BATCH, jobs.length)}/${jobs.length}`);
  }
  console.log(`Re-embedded ${count} jobs.`);

  // 4. Re-embed every résumé + the active profile from their stored raw_text.
  let rc = 0;
  try {
    const resumes = db.prepare('SELECT id, raw_text FROM resumes WHERE raw_text IS NOT NULL').all() as ResumeRow[];
    const updRes = db.prepare('UPDATE resumes SET embedding = ? WHERE id = ?');
    for (const r of resumes) {
      if (!r.raw_text) continue;
      try { updRes.run(embeddingToBlob(await generateEmbedding(r.raw_text)), r.id); rc++; }
      catch (e) { console.error(`  ✗ resume ${r.id}: ${(e as Error).message}`); }
    }
  } catch { /* resumes table may not exist */ }
  const prof = db.prepare('SELECT raw_text FROM my_profile WHERE id = 1').get() as { raw_text: string | null } | undefined;
  if (prof?.raw_text) {
    try { db.prepare('UPDATE my_profile SET embedding = ? WHERE id = 1').run(embeddingToBlob(await generateEmbedding(prof.raw_text))); console.log('Re-embedded active profile.'); }
    catch (e) { console.error('  ✗ profile:', (e as Error).message); }
  }
  console.log(`Re-embedded ${rc} résumé(s).`);

  // 5. Record the new corpus signature.
  recordEmbeddingSignature(db);
  console.log(`\nDone. Corpus signature is now ${target}. Matches recompute on next app load.\n`);
  db.close();
}

main().catch((e) => { console.error('reembed failed:', e); process.exit(1); });
