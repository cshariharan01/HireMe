import { NextRequest, NextResponse } from 'next/server';
import { getRecipe, listRecipes, recordApplyAttempt } from '@/lib/apply/recipes';

export const runtime = 'nodejs';

/**
 * GET /api/apply/recipes?host=<host>  — every learned employer recipe, or a single host's.
 * The settings UI and the apply pipeline read these so a repeat visit to the same employer starts
 * from learned reveal labels and known login/CAPTCHA gates instead of cold-probing again.
 */
export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get('host');
  if (host) {
    return NextResponse.json({ recipe: getRecipe(host) });
  }
  return NextResponse.json({ recipes: listRecipes() });
}

/**
 * POST /api/apply/recipes  { host, outcome?, loginRequired?, captchaGated?, revealLabels? }
 * Merge an observed outcome into a host's recipe (used by the apply pipeline; also callable from
 * the UI to pre-seed a known employer, e.g. "Accenture always needs a sign-in").
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    host?: string;
    outcome?: string;
    loginRequired?: boolean;
    captchaGated?: boolean;
    revealLabels?: string[];
    closedPosting?: boolean;
  } | null;
  if (!body || !body.host || !body.host.trim()) {
    return NextResponse.json({ error: 'Missing host.' }, { status: 400 });
  }
  recordApplyAttempt(body.host, {
    outcome: body.outcome,
    loginRequired: body.loginRequired,
    captchaGated: body.captchaGated,
    closedPosting: body.closedPosting,
    revealLabels: body.revealLabels,
  });
  return NextResponse.json({ ok: true, recipe: getRecipe(body.host) });
}