import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { generateEmbedding, embeddingToBlob } from '@/lib/embeddings';
import { assertEmbeddingConsistent, recordEmbeddingSignature } from '@/lib/embedding-signature';
import { isDomainPriority } from '@/lib/ontology';
import { createHash } from 'crypto';

export async function POST(request: NextRequest) {
  try {
    const { company, title, location, description, url, source } = await request.json();

    if (!title || !company) {
      return NextResponse.json({ error: 'Company and title are required' }, { status: 400 });
    }

    const dedupHash = createHash('sha256')
      .update((source || 'manual') + company + title + (location || ''))
      .digest('hex');

    // Check if already exists
    const existing = db.prepare('SELECT id FROM job_postings WHERE dedup_hash = ?').get(dedupHash);
    if (existing) {
      return NextResponse.json({ error: 'This job already exists', id: (existing as { id: number }).id }, { status: 409 });
    }

    const dp = isDomainPriority(title + ' ' + (description || '')) ? 1 : 0;

    // Guard: refuse to embed into a corpus that used a different provider (would corrupt matching).
    try {
      assertEmbeddingConsistent(db);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Embedding provider mismatch' }, { status: 409 });
    }

    // Generate embedding immediately for manual imports
    let embeddingBlob: Buffer | null = null;
    try {
      const embText = `${title} ${company} ${(description || '').slice(0, 2000)}`;
      const embedding = await generateEmbedding(embText);
      embeddingBlob = embeddingToBlob(embedding);
      recordEmbeddingSignature(db); // first embed establishes the corpus's embedding space
    } catch {
      // Embedding will be null — can be generated later via npm run embed
    }

    const result = db.prepare(`
      INSERT INTO job_postings (source, company, title, location, description, url, embedding, domain_priority, dedup_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source || 'manual',
      company,
      title,
      location || '',
      description || '',
      url || '',
      embeddingBlob,
      dp,
      dedupHash
    );

    return NextResponse.json({
      success: true,
      id: result.lastInsertRowid,
      domainPriority: dp,
      embedded: !!embeddingBlob,
    });
  } catch (error) {
    console.error('Import error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to import job' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const stats = db.prepare(`
      SELECT source, COUNT(*) as count,
        SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as embedded,
        SUM(domain_priority) as healthcare_it
      FROM job_postings
      GROUP BY source
      ORDER BY count DESC
    `).all();

    const total = db.prepare('SELECT COUNT(*) as count FROM job_postings').get() as { count: number };

    return NextResponse.json({ stats, total: total.count });
  } catch (error) {
    console.error('Stats error:', error);
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
