import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';

/**
 * Search the company career-board directory (`ats_companies`).
 *
 * RANKING MATTERS MORE THAN IT LOOKS. A plain `LIKE '%q%'` returns plausible-looking nonsense:
 * searching "Elevance" surfaced "Relevance AI", "Mayo" surfaced "Mayors Migration Council", and
 * "CVS" surfaced "acvs". Adding the wrong company imports a whole board of irrelevant jobs under a
 * name the user thinks they recognise, so exact and prefix matches are ranked hard above substring
 * ones and the tier is returned so the UI can show it.
 */
interface Row {
  ats: string;
  name: string;
  slug: string;
  url: string | null;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);

    const total = (db.prepare('SELECT COUNT(*) c FROM ats_companies').get() as { c: number }).c;
    if (total === 0) {
      return NextResponse.json({
        results: [],
        total: 0,
        empty: true,
        hint: 'Directory is empty — run `npm run sync:directory` to download it (~7MB, one time).',
      });
    }
    if (q.length < 2) return NextResponse.json({ results: [], total });

    // Rank: 0 exact · 1 prefix · 2 word-start · 3 anywhere. Shorter names win inside a tier, which
    // keeps "Cigna" above "Cigna Group Holdings LLC" for the query "cigna".
    const rows = db
      .prepare(
        `SELECT ats, name, slug, url,
                CASE
                  WHEN LOWER(name) = LOWER(?)        THEN 0
                  WHEN LOWER(name) LIKE LOWER(?)     THEN 1
                  WHEN LOWER(name) LIKE LOWER(?)     THEN 2
                  ELSE 3
                END AS tier
           FROM ats_companies
          WHERE name LIKE ? COLLATE NOCASE
          ORDER BY tier ASC, LENGTH(name) ASC, name ASC
          LIMIT ?`,
      )
      .all(q, `${q}%`, `% ${q}%`, `%${q}%`, limit) as Array<Row & { tier: number }>;

    return NextResponse.json({
      total,
      results: rows.map((r) => ({
        ats: r.ats,
        name: r.name,
        slug: r.slug,
        url: r.url,
        // `exact` drives a badge in the UI: a tier-3 hit is a guess, not a match.
        match: r.tier === 0 ? 'exact' : r.tier === 1 ? 'starts-with' : r.tier === 2 ? 'word' : 'partial',
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Directory search failed' },
      { status: 500 },
    );
  }
}

/**
 * Add a company to the seed list so every future `npm run discover` includes it.
 *
 * Seeds are appended as the board URL, not the name: for Workday the name is useless (tenant +
 * data-centre + site cannot be derived from it) and for everything else the URL is unambiguous,
 * which the ranking notes above show matters — "Cigna" and "Cigna Group" are different boards.
 */
export async function POST(req: NextRequest) {
  try {
    const { url: boardUrl, name } = (await req.json()) as { url?: string; name?: string };
    if (!boardUrl || !/^https?:\/\//i.test(boardUrl)) {
      return NextResponse.json({ error: 'A board URL is required' }, { status: 400 });
    }

    const file = path.join(process.cwd(), 'scripts', 'data', 'companies.txt');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const trimmed = boardUrl.trim();
    if (existing.split(/\r?\n/).some((l) => l.trim() === trimmed)) {
      return NextResponse.json({
        ok: true,
        already: true,
        message: `${name || trimmed} is already seeded`,
      });
    }

    // Built from a named constant so the newline survives any future codegen pass.
    const NL = '\n';
    const comment = name ? `# ${name}${NL}` : '';
    const prefix = existing === '' || existing.endsWith(NL) ? '' : NL;
    fs.appendFileSync(file, `${prefix}${comment}${trimmed}${NL}`, 'utf8');
    return NextResponse.json({ ok: true, message: `${name || trimmed} added to the seed list` });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not update the seed list' },
      { status: 500 },
    );
  }
}
