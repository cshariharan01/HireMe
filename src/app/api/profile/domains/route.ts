import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { deriveDomainTerms } from '@/lib/llm';

// POST /api/profile/domains — re-derive the resume's domain vocabulary ("Focus areas")
// from the stored profile (no PDF re-upload). Refreshes `domain_terms`; these feed the
// matcher's soft +0.05 domain boost. Mirrors /api/profile/roles.
export async function POST() {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as { parsed_json: string } | undefined;
    if (!row) return NextResponse.json({ error: 'No profile — upload a resume first' }, { status: 404 });

    const parsed = JSON.parse(row.parsed_json);
    const domainTerms = await deriveDomainTerms(parsed);
    const merged = { ...parsed, domain_terms: domainTerms };
    db.prepare('UPDATE my_profile SET parsed_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(JSON.stringify(merged));

    return NextResponse.json({ success: true, domainTerms, profile: merged });
  } catch (error) {
    console.error('Regenerate domains error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to derive domain terms' },
      { status: 500 }
    );
  }
}

// PATCH /api/profile/domains { domain_terms: string[] } — save the user's edited Focus areas.
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const raw = Array.isArray(body?.domain_terms) ? body.domain_terms : null;
    if (!raw) return NextResponse.json({ error: 'domain_terms must be an array' }, { status: 400 });

    // Normalize: strings only, trimmed, de-duped (case-insensitive), capped at 25.
    const seen = new Set<string>();
    const domainTerms: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const term = item.trim().replace(/\s+/g, ' ');
      if (!term || term.length > 40) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      domainTerms.push(term);
      if (domainTerms.length >= 25) break;
    }

    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as { parsed_json: string } | undefined;
    if (!row) return NextResponse.json({ error: 'No profile — upload a resume first' }, { status: 404 });
    const merged = { ...JSON.parse(row.parsed_json), domain_terms: domainTerms };
    db.prepare('UPDATE my_profile SET parsed_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(JSON.stringify(merged));

    return NextResponse.json({ success: true, domainTerms, profile: merged });
  } catch (error) {
    console.error('Save domains error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save domain terms' },
      { status: 500 }
    );
  }
}
