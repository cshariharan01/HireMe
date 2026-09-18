import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getActiveResumeId } from '@/lib/resumes';
import { compileLatex, hasLatexCompiler, looksLikeLatexTemplate } from '@/lib/apply/latex';

export const runtime = 'nodejs';

/**
 * GET /api/resume/latex — the active resume's LaTeX TEMPLATE plus pipeline status
 * (compiler present? template looks compilable?). The UI uses this to decide whether to show
 * the LaTeX lane or the Markdown fallback.
 */
export async function GET() {
  const profile = db
    .prepare('SELECT resume_tex, parsed_json FROM my_profile WHERE id = 1')
    .get() as { resume_tex: string | null; parsed_json: string | null } | undefined;
  const tex = profile?.resume_tex ?? null;
  const hasCompiler = await hasLatexCompiler();
  return NextResponse.json({
    resumeTex: tex || null,
    hasCompiler,
    templateDetected: looksLikeLatexTemplate(tex),
    templateName: profile?.parsed_json ? JSON.parse(profile.parsed_json)?.name || null : null,
  });
}

/**
 * POST /api/resume/latex  { tex: string }
 * Save the user's Overleaf template (full main.tex). Also stored on the active resume library row
 * so switching resumes switches templates. A sanitized compile-test round-trips the text to prove
 * it builds before accepting it — a bad template would only fail later, mid-application.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { tex?: string } | null;
  if (!body || typeof body.tex !== 'string' || !body.tex.trim()) {
    return NextResponse.json({ error: 'Missing LaTeX source.' }, { status: 400 });
  }
  const tex = body.tex.trim();

  // If a compiler exists, verify the template actually builds BEFORE accepting it.
  if (await hasLatexCompiler()) {
    try {
      await compileLatex(tex);
    } catch (e) {
      return NextResponse.json(
        { error: `Template does not compile with the installed LaTeX: ${(e as Error).message.slice(0, 300)}` },
        { status: 400 },
      );
    }
  }

  const active = getActiveResumeId();
  db.prepare(
    `INSERT INTO my_profile (id, resume_tex, updated_at)
     VALUES (1, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET resume_tex = excluded.resume_tex, updated_at = CURRENT_TIMESTAMP`,
  ).run(tex);

  if (active) {
    db.prepare('UPDATE resumes SET resume_tex = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tex, active);
  }

  return NextResponse.json({ ok: true, saved: true, hasCompiler: await hasLatexCompiler(), templateDetected: looksLikeLatexTemplate(tex) });
}