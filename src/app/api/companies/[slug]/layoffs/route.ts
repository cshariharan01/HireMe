import { NextResponse } from 'next/server';
import { findLayoffsForCompany } from '@/lib/layoffs';

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// GET /api/companies/[slug]/layoffs — instant SQL lookup against the bulk-ingested
// Layoffs.fyi cache. To refresh the underlying data, run `npm run ingest:layoffs`.
export async function GET(_req: Request, props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  try {
    const slug = normalizeSlug(params.slug);
    if (!slug) return NextResponse.json({ error: 'Invalid slug' }, { status: 400 });
    return NextResponse.json({ summary: findLayoffsForCompany(slug) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}
