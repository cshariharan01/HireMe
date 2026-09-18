import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { getEmbeddingInfo, getEmbeddingSignature } from '@/lib/embeddings';
import { readEmbeddingSignature } from '@/lib/embedding-signature';

// GET /api/embeddings/info — the active embedding provider/model, the corpus's recorded signature,
// whether they're consistent, and how many jobs are embedded. Drives the Settings "Embeddings" card.
export async function GET() {
  try {
    const info = getEmbeddingInfo();
    const current = getEmbeddingSignature();
    const corpusSignature = readEmbeddingSignature(db);
    const embeddedJobs = (db.prepare('SELECT COUNT(*) AS n FROM job_postings WHERE embedding IS NOT NULL').get() as { n: number }).n;
    return NextResponse.json({
      provider: info.provider,
      model: info.model,
      signature: current,
      corpusSignature,
      consistent: !corpusSignature || corpusSignature === current,
      embeddedJobs,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 });
  }
}
