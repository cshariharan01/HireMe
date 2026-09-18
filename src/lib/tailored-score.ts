import db from '@/lib/db';
import { getTailoredMatchScore } from '@/lib/matches';

export function stripLatexToText(tex: string): string {
  const beginIdx = tex.indexOf('\\begin{document}');
  const endIdx = tex.lastIndexOf('\\end{document}');
  let body = tex;
  if (beginIdx !== -1) {
    body = endIdx !== -1 ? tex.slice(beginIdx + '\\begin{document}'.length, endIdx) : tex.slice(beginIdx + '\\begin{document}'.length);
  }
  return body
    .replace(/^%[^\n]*$/gm, '')
    .replace(/\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g, '\n$2\n')
    .replace(/\\resumeSubheading\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g, '$1 $2 $3 $4 ')
    .replace(/\\resumeProjectHeading\{([^}]*)\}\{([^}]*)\}/g, '$1 $2 ')
    .replace(/\\resumeItem\{/g, ' ')
    .replace(/\\[a-zA-Z]+(?:\*|\[[^\]]*\])?(?:\{([^}]*)\})?/g, '$1 ')
    .replace(/[{}\\%&$#_~^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes the fit score of a candidate's tailored résumé against a job description,
 * and persists the resulting `tailored_score` and `default_score` into both `my_applications`
 * and `job_documents`.
 */
export async function calculateAndStoreTailoredScore(
  jobId: number,
  explicitResumeText?: string,
): Promise<{ score: number; defaultScore: number | null; delta: number | null } | null> {
  if (!jobId) return null;

  const job = db
    .prepare('SELECT id, title, description, embedding FROM job_postings WHERE id = ?')
    .get(jobId) as { id: number; title: string; description: string | null; embedding: Buffer | null } | undefined;
  if (!job) return null;

  // Ensure job posting vector embedding exists for cosine similarity
  if (!job.embedding && (job.description || job.title)) {
    try {
      const { generateEmbedding, embeddingToBlob } = await import('@/lib/embeddings');
      const emb = await generateEmbedding(`${job.title}\n\n${job.description || ''}`);
      db.prepare('UPDATE job_postings SET embedding = ? WHERE id = ?').run(embeddingToBlob(emb), jobId);
    } catch (e) {
      console.warn('[tailored-score] failed to generate embedding for job:', e);
    }
  }

  let tailoredText = (explicitResumeText || '').trim();
  if (!tailoredText) {
    const cached = db
      .prepare('SELECT resume_variant, resume_tex FROM job_documents WHERE job_id = ?')
      .get(jobId) as { resume_variant: string | null; resume_tex: string | null } | undefined;
    const applied = db
      .prepare('SELECT resume_variant, resume_tex FROM my_applications WHERE job_id = ?')
      .get(jobId) as { resume_variant: string | null; resume_tex: string | null } | undefined;

    const candidateVariant = (applied?.resume_variant || cached?.resume_variant || '').trim();
    const candidateTex = (applied?.resume_tex || cached?.resume_tex || '').trim();

    if (candidateTex) {
      tailoredText = stripLatexToText(candidateTex);
    } else if (candidateVariant) {
      tailoredText = candidateVariant;
    }
  } else if (tailoredText.includes('\\documentclass') || tailoredText.includes('\\begin{document}')) {
    tailoredText = stripLatexToText(tailoredText);
  }

  if (!tailoredText) return null;

  try {
    const result = await getTailoredMatchScore(jobId, tailoredText);
    if (!result) return null;

    const { tailoredMatch, defaultMatch } = result;
    const score = tailoredMatch.score;
    const defaultScore = defaultMatch?.score ?? null;

    try {
      db.prepare('UPDATE my_applications SET tailored_score = ?, default_score = ? WHERE job_id = ?').run(
        score,
        defaultScore,
        jobId,
      );
    } catch {
      /* safe fallback */
    }

    try {
      db.prepare('UPDATE job_documents SET tailored_score = ?, default_score = ? WHERE job_id = ?').run(
        score,
        defaultScore,
        jobId,
      );
    } catch {
      /* safe fallback */
    }

    return {
      score,
      defaultScore,
      delta: defaultScore != null ? score - defaultScore : null,
    };
  } catch (e) {
    console.error('[calculateAndStoreTailoredScore] error for jobId', jobId, ':', e);
    return null;
  }
}
