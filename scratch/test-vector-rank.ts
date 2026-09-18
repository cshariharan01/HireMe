import db from '../src/lib/db';
import { generateEmbedding, embeddingToBlob } from '../src/lib/embeddings';

function cleanStrip(tex: string): string {
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

async function test() {
  const app = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;
  const stripped = cleanStrip(app.resume_tex);
  const emb = await generateEmbedding(stripped);
  const queryBlob = embeddingToBlob(emb);

  // Find rank of 1000055 among all job_postings ordered by distance
  const allRows = db.prepare(`
    SELECT j.id, j.title, j.company, vec_distance_cosine(j.embedding, ?) AS distance
    FROM job_postings j
    WHERE j.embedding IS NOT NULL
    ORDER BY distance ASC
  `).all(queryBlob) as Array<{ id: number; title: string; company: string; distance: number }>;

  const rank = allRows.findIndex(r => r.id === 1000055);
  console.log(`Total jobs with embedding: ${allRows.length}`);
  console.log(`Rank of Yantran (1000055): ${rank + 1} with distance: ${allRows[rank]?.distance}`);
  console.log('Top 5 jobs:');
  allRows.slice(0, 5).forEach((r, i) => console.log(`  #${i+1} [${r.id}] ${r.company} - ${r.title}: dist ${r.distance}`));
}

test().catch(console.error);
