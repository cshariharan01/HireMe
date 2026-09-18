// Layoffs.fyi data lookup. Pure SQL — data is bulk-ingested via `npm run ingest:layoffs`.
// No on-view scraping; this is fast (a single indexed query per company).

import db from './db';

export interface LayoffEvent {
  company: string;
  layoff_date: string | null;
  laid_off_count: number | null;
  laid_off_pct: number | null;
  industry: string | null;
  country: string | null;
  location_hq: string | null;
  stage: string | null;
  funds_raised_mm: number | null;
  source_url: string | null;
}

export interface LayoffSummary {
  events: LayoffEvent[];
  totalEvents: number;
  totalLaidOff: number;
  mostRecentDate: string | null;
  recentEvent: LayoffEvent | null;          // single most recent
  riskFlag: 'none' | 'low' | 'moderate' | 'high';
  riskNote: string;
}

export function findLayoffsForCompany(slug: string): LayoffSummary {
  const events = db
    .prepare(
      `SELECT company, layoff_date, laid_off_count, laid_off_pct, industry, country,
              location_hq, stage, funds_raised_mm, source_url
       FROM layoffs_data
       WHERE company_slug = ?
       ORDER BY layoff_date DESC NULLS LAST`,
    )
    .all(slug) as LayoffEvent[];

  if (events.length === 0) {
    return {
      events: [],
      totalEvents: 0,
      totalLaidOff: 0,
      mostRecentDate: null,
      recentEvent: null,
      riskFlag: 'none',
      riskNote: 'No layoff events on record at Layoffs.fyi.',
    };
  }

  const totalLaidOff = events.reduce((s, e) => s + (e.laid_off_count || 0), 0);
  const mostRecentDate = events[0].layoff_date;
  const ageMonths = mostRecentDate
    ? Math.max(0, (Date.now() - new Date(mostRecentDate).getTime()) / (1000 * 60 * 60 * 24 * 30))
    : Infinity;

  // Risk heuristic — recency × magnitude × frequency.
  // - Layoff in last 6 months → high risk
  // - Layoff in last 18 months → moderate risk
  // - Layoff older than 18 months but multiple events → low risk
  // - Layoff older than 18 months, single event → low (recovered)
  let riskFlag: LayoffSummary['riskFlag'];
  let riskNote: string;
  if (ageMonths < 6) {
    riskFlag = 'high';
    riskNote = `Recent layoff: ${events[0].laid_off_count || '?'} cut ${events[0].layoff_date}${events[0].laid_off_pct ? ` (${Math.round(events[0].laid_off_pct * 100)}% of headcount)` : ''}.`;
  } else if (ageMonths < 18) {
    riskFlag = 'moderate';
    riskNote = `Layoff ${Math.round(ageMonths)} months ago: ${events[0].laid_off_count || '?'} cut${events[0].laid_off_pct ? ` (${Math.round(events[0].laid_off_pct * 100)}%)` : ''}.`;
  } else if (events.length >= 2) {
    riskFlag = 'low';
    riskNote = `${events.length} layoff events on record; most recent ${Math.round(ageMonths)} months ago. Pattern of cycles.`;
  } else {
    riskFlag = 'low';
    riskNote = `Single layoff event ${Math.round(ageMonths)} months ago — likely recovered.`;
  }

  return {
    events,
    totalEvents: events.length,
    totalLaidOff,
    mostRecentDate,
    recentEvent: events[0],
    riskFlag,
    riskNote,
  };
}

// Compact one-line text representation for prompt injection.
export function summarizeLayoffsForPrompt(slug: string): string {
  const s = findLayoffsForCompany(slug);
  if (s.totalEvents === 0) return 'Layoffs.fyi: no layoff events on record.';
  const events = s.events
    .slice(0, 3)
    .map((e) => {
      const cnt = e.laid_off_count || '?';
      const pct = e.laid_off_pct ? ` (${Math.round(e.laid_off_pct * 100)}%)` : '';
      return `${e.layoff_date || '?'}: ${cnt} laid off${pct}`;
    })
    .join('; ');
  return `Layoffs.fyi: ${s.totalEvents} event${s.totalEvents === 1 ? '' : 's'}, ~${s.totalLaidOff.toLocaleString()} total laid off. Most recent: ${events}. Risk flag: ${s.riskFlag}.`;
}
