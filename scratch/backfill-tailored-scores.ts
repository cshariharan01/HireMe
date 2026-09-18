import db from '../src/lib/db';
import { getTailoredMatchScore } from '../src/lib/matches';

function stripLatexToText(tex: string): string {
  return tex
    .replace(/^%[^\n]*$/gm, '')
    .replace(/\\[a-zA-Z]+(?:\*|\[[^\]]*\])?(?:\{([^}]*)\})?/g, '$1 ')
    .replace(/[{}\\%&$#_~^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const apps = db
    .prepare(
      `SELECT a.job_id, j.company, j.title, a.resume_variant, a.resume_tex
       FROM my_applications a
       JOIN job_postings j ON a.job_id = j.id
       WHERE (a.resume_variant IS NOT NULL OR a.resume_tex IS NOT NULL)`
    )
    .all() as Array<{ job_id: number; company: string; title: string; resume_variant: string | null; resume_tex: string | null }>;

  console.log(`Found ${apps.length} applications with tailored resumes.`);

  for (const app of apps) {
    let tailoredText = (app.resume_variant || '').trim();
    if (!tailoredText && app.resume_tex) {
      tailoredText = stripLatexToText(app.resume_tex);
    } else if (tailoredText.includes('\\documentclass') || tailoredText.includes('\\begin{document}')) {
      tailoredText = stripLatexToText(tailoredText);
    }

    if (!tailoredText) continue;

    console.log(`Scoring job ${app.job_id} (${app.company} - ${app.title})...`);
    try {
      const result = await getTailoredMatchScore(app.job_id, tailoredText);
      if (result) {
        const score = result.tailoredMatch.score;
        const defaultScore = result.defaultMatch?.score ?? null;
        console.log(`  -> Tailored score: ${score}%, default: ${defaultScore}% (delta: ${defaultScore != null ? score - defaultScore : 'N/A'})`);
        db.prepare('UPDATE my_applications SET tailored_score = ?, default_score = ? WHERE job_id = ?').run(
          score,
          defaultScore,
          app.job_id
        );
        db.prepare('UPDATE job_documents SET tailored_score = ?, default_score = ? WHERE job_id = ?').run(
          score,
          defaultScore,
          app.job_id
        );
      } else {
        console.log(`  -> No result returned for job ${app.job_id}`);
      }
    } catch (err) {
      console.error(`  -> Failed scoring job ${app.job_id}:`, err);
    }
  }

  console.log('Finished backfilling scores.');
}

main().catch(console.error);
