import { NextRequest, NextResponse } from 'next/server';
import { saveJobDocument } from '@/lib/apply/documents';
import db from '@/lib/db';
import { generateResumeVariant, generateLatexResume } from '@/lib/llm';
import { looksLikeLatexTemplate, hasLatexCompiler, compileLatexWithRepair } from '@/lib/apply/latex';

interface JobRow {
  id: number;
  company: string;
  title: string;
  description: string;
}

interface ProfileRow {
  parsed_json: string;
  resume_tex: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const { jobId } = await request.json();

    const job = db.prepare('SELECT id, company, title, description FROM job_postings WHERE id = ?')
      .get(jobId) as JobRow | undefined;

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const profile = db.prepare('SELECT parsed_json, resume_tex FROM my_profile WHERE id = 1')
      .get() as ProfileRow | undefined;

    if (!profile) {
      return NextResponse.json({ error: 'No resume uploaded' }, { status: 400 });
    }

    const resumeJson = JSON.parse(profile.parsed_json);
    const result = await generateResumeVariant(
      resumeJson,
      job.title,
      job.company,
      job.description || ''
    );
    const resumeVariant = result.text;

    // Cache WITHOUT fabricating an application. Inserting a row with status='applied'
    // here meant generating a document removed the job from the match list, the digest
    // and every rating path. `saveJobDocument` writes to the application only if the user
    // really applied; otherwise it goes to the `job_documents` cache.
    saveJobDocument(jobId, 'resume_variant', resumeVariant);

    // If candidate has an Overleaf LaTeX template and compiler is installed, also generate
    // and compile the tailored LaTeX resume so it is immediately cached for apply.
    if (looksLikeLatexTemplate(profile.resume_tex) && (await hasLatexCompiler())) {
      try {
        const latexRes = await generateLatexResume(
          resumeJson,
          profile.resume_tex as string,
          job.title,
          job.company,
          job.description || '',
          { interactive: true }
        );
        if (latexRes?.text) {
          const { tex: verifiedTex } = await compileLatexWithRepair(
            latexRes.text,
            (err) =>
              generateLatexResume(
                resumeJson,
                profile.resume_tex as string,
                job.title,
                job.company,
                job.description || '',
                { interactive: true, fixHint: err }
              ).then((r) => r.text)
          );
          saveJobDocument(jobId, 'resume_tex', verifiedTex);
        }
      } catch (err) {
        console.warn('[generate/resume-variant] LaTeX generation/compile skipped or failed:', err);
      }
    }

    return NextResponse.json({ resumeVariant, coverage: result.coverage });
  } catch (error) {
    console.error('Resume variant error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate resume variant' },
      { status: 500 }
    );
  }
}
