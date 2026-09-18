import db from '../src/lib/db';
import { generateEmbedding, embeddingToBlob, blobToEmbedding } from '../src/lib/embeddings';
import { stripLatexToText } from '../src/lib/tailored-score';
import { buildFtsQuery, jobFtsAvailable } from '../src/lib/db';
import { canonicalizeSkill, findSkills } from '../src/lib/skills-vocab';

async function test() {
  const prof = db.prepare('SELECT parsed_json, embedding, resume_tex FROM my_profile WHERE id = 1').get() as any;
  const parsedProf = JSON.parse(prof.parsed_json);
  const app = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;
  const stripped = stripLatexToText(app.resume_tex);
  const tailoredEmb = await generateEmbedding(stripped);

  const defaultQueryBlob = prof.embedding;
  const tailoredQueryBlob = embeddingToBlob(tailoredEmb);

  // Vector leg comparison
  const defVec = db.prepare('SELECT id, vec_distance_cosine(embedding, ?) as d FROM job_postings WHERE embedding IS NOT NULL ORDER BY d ASC LIMIT 300').all(defaultQueryBlob) as any[];
  const tailVec = db.prepare('SELECT id, vec_distance_cosine(embedding, ?) as d FROM job_postings WHERE embedding IS NOT NULL ORDER BY d ASC LIMIT 300').all(tailoredQueryBlob) as any[];

  console.log('Default vector rank of 1000055:', defVec.findIndex(r => r.id === 1000055) + 1, 'dist:', defVec.find(r => r.id === 1000055)?.d);
  console.log('Tailored vector rank of 1000055:', tailVec.findIndex(r => r.id === 1000055) + 1, 'dist:', tailVec.find(r => r.id === 1000055)?.d);

  // Lexical terms comparison
  const defLexicalTerms = [
    ...(parsedProf.targets?.roles || []),
    ...(parsedProf.skills || []).map(canonicalizeSkill),
    ...(parsedProf.targets?.domains || []),
  ];
  const defFtsQuery = buildFtsQuery(defLexicalTerms);
  const defLex = db.prepare(`
    SELECT f.id, f.rank FROM (
      SELECT rowid AS id, bm25(job_fts, 10.0, 2.0, 1.0) AS rank
      FROM job_fts WHERE job_fts MATCH ?
      ORDER BY rank LIMIT 600
    ) f JOIN job_postings j ON j.id = f.id WHERE j.embedding IS NOT NULL
    ORDER BY f.rank LIMIT 300
  `).all(defFtsQuery) as any[];

  const tailoredSkills = findSkills(stripped);
  const tailLexicalTerms = [
    ...(parsedProf.targets?.roles || []),
    ...tailoredSkills.map(canonicalizeSkill),
    ...(parsedProf.targets?.domains || []),
  ];
  const tailFtsQuery = buildFtsQuery(tailLexicalTerms);
  const tailLex = db.prepare(`
    SELECT f.id, f.rank FROM (
      SELECT rowid AS id, bm25(job_fts, 10.0, 2.0, 1.0) AS rank
      FROM job_fts WHERE job_fts MATCH ?
      ORDER BY rank LIMIT 600
    ) f JOIN job_postings j ON j.id = f.id WHERE j.embedding IS NOT NULL
    ORDER BY f.rank LIMIT 300
  `).all(tailFtsQuery) as any[];

  console.log('Default lexical rank of 1000055:', defLex.findIndex(r => r.id === 1000055) + 1, 'rank:', defLex.find(r => r.id === 1000055)?.rank);
  console.log('Tailored lexical rank of 1000055:', tailLex.findIndex(r => r.id === 1000055) + 1, 'rank:', tailLex.find(r => r.id === 1000055)?.rank);
}

test().catch(console.error);
