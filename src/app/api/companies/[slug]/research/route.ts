import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { researchCompany, getActiveProviderName, type CompanyBrief } from '@/lib/llm';

interface BriefRow {
  company_slug: string;
  display_name: string;
  provider: string;
  computed_at: string;
  financial_health_score: number;
  financial_health_summary: string;
  funding_summary: string;
  layoffs_summary: string;
  growth_signal: string;
  culture_score: number;
  culture_summary: string;
  positive_themes: string;          // JSON
  concerns: string;                 // JSON
  retention_signal: string;
  comp_summary: string;
  legitimacy_score: number;
  legitimacy_notes: string;
  overall_score: number;
  recommendation: string;
  questions_for_recruiter: string;  // JSON
  evidence_sources: string;         // JSON
}

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function rowToBrief(row: BriefRow): CompanyBrief & { display_name: string; provider: string; computed_at: string } {
  const safeJsonArray = <T>(s: string, fallback: T[]): T[] => {
    try {
      const v = JSON.parse(s || '[]');
      return Array.isArray(v) ? v : fallback;
    } catch { return fallback; }
  };
  return {
    display_name: row.display_name,
    provider: row.provider,
    computed_at: row.computed_at,
    financial_health_score: row.financial_health_score,
    financial_health_summary: row.financial_health_summary,
    funding_summary: row.funding_summary,
    layoffs_summary: row.layoffs_summary,
    growth_signal: row.growth_signal,
    culture_score: row.culture_score,
    culture_summary: row.culture_summary,
    positive_themes: safeJsonArray<string>(row.positive_themes, []),
    concerns: safeJsonArray<string>(row.concerns, []),
    retention_signal: row.retention_signal,
    comp_summary: row.comp_summary,
    legitimacy_score: row.legitimacy_score,
    legitimacy_notes: row.legitimacy_notes,
    overall_score: row.overall_score,
    recommendation: (row.recommendation as 'apply' | 'hold' | 'pass'),
    questions_for_recruiter: safeJsonArray<string>(row.questions_for_recruiter, []),
    evidence_sources: safeJsonArray<{ label: string; url: string }>(row.evidence_sources, []),
  };
}

// POST /api/companies/[slug]/research?refresh=1
// Body: { display_name?: string, role_hint?: string, location_hint?: string, industry_hint?: string }
export async function POST(req: NextRequest, props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  try {
    const slug = normalizeSlug(params.slug);
    if (!slug) return NextResponse.json({ error: 'Invalid company slug' }, { status: 400 });

    const url = new URL(req.url);
    const force = url.searchParams.get('refresh') === '1';
    // cacheOnly: return the cached brief if present, else null — never run the LLM (+web search).
    const cacheOnly = url.searchParams.get('cacheOnly') === '1';
    const body = await req.json().catch(() => ({}));
    const displayName: string = body.display_name || params.slug;

    if (!force) {
      const cached = db.prepare('SELECT * FROM company_briefs WHERE company_slug = ?').get(slug) as BriefRow | undefined;
      // A cached brief with a null overall_score is a corrupt/partial legacy row (an older LLM
      // parse that wasn't coerced). Don't serve it — treat as a miss so it regenerates on demand
      // (and never reaches the UI, which would otherwise render a scoreless, broken panel).
      if (cached && cached.overall_score != null) return NextResponse.json({ brief: rowToBrief(cached), cached: true });
      if (cacheOnly) return NextResponse.json({ brief: null, cached: false });
    }

    const brief = await researchCompany(
      displayName,
      body.industry_hint || '',
      body.location_hint || '',
      body.role_hint || ''
    );

    const provider = getActiveProviderName();

    db.prepare(
      `INSERT INTO company_briefs (
         company_slug, display_name, provider,
         financial_health_score, financial_health_summary, funding_summary, layoffs_summary, growth_signal,
         culture_score, culture_summary, positive_themes, concerns, retention_signal,
         comp_summary, legitimacy_score, legitimacy_notes, overall_score, recommendation,
         questions_for_recruiter, evidence_sources
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_slug) DO UPDATE SET
         display_name = excluded.display_name,
         provider = excluded.provider,
         computed_at = CURRENT_TIMESTAMP,
         financial_health_score = excluded.financial_health_score,
         financial_health_summary = excluded.financial_health_summary,
         funding_summary = excluded.funding_summary,
         layoffs_summary = excluded.layoffs_summary,
         growth_signal = excluded.growth_signal,
         culture_score = excluded.culture_score,
         culture_summary = excluded.culture_summary,
         positive_themes = excluded.positive_themes,
         concerns = excluded.concerns,
         retention_signal = excluded.retention_signal,
         comp_summary = excluded.comp_summary,
         legitimacy_score = excluded.legitimacy_score,
         legitimacy_notes = excluded.legitimacy_notes,
         overall_score = excluded.overall_score,
         recommendation = excluded.recommendation,
         questions_for_recruiter = excluded.questions_for_recruiter,
         evidence_sources = excluded.evidence_sources`
    ).run(
      slug,
      displayName,
      provider,
      brief.financial_health_score,
      brief.financial_health_summary,
      brief.funding_summary,
      brief.layoffs_summary,
      brief.growth_signal,
      brief.culture_score,
      brief.culture_summary,
      JSON.stringify(brief.positive_themes),
      JSON.stringify(brief.concerns),
      brief.retention_signal,
      brief.comp_summary,
      brief.legitimacy_score,
      brief.legitimacy_notes,
      brief.overall_score,
      brief.recommendation,
      JSON.stringify(brief.questions_for_recruiter),
      JSON.stringify(brief.evidence_sources)
    );

    return NextResponse.json({ brief: { ...brief, display_name: displayName, provider, computed_at: new Date().toISOString() }, cached: false });
  } catch (error) {
    console.error('Company research error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to research company' },
      { status: 500 }
    );
  }
}
