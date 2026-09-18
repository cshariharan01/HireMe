import db from '../src/lib/db';
import { generateEmbedding, blobToEmbedding, embeddingToBlob } from '../src/lib/embeddings';

async function test() {
  const yJob = db.prepare('SELECT id, title, description, embedding FROM job_postings WHERE id = 1000055').get() as any;
  const yApp = db.prepare('SELECT resume_tex FROM my_applications WHERE job_id = 1000055').get() as any;

  console.log('Yantran job title:', yJob.title);
  console.log('Yantran job embedding length in bytes:', yJob.embedding?.length);

  // Re-generate embedding for Yantran job to verify
  const jobText = `${yJob.title}\n\n${yJob.description || ''}`;
  console.log('Job text length:', jobText.length);
  const emb = await generateEmbedding(jobText);
  console.log('Generated emb dimension:', emb.length);

  // Check distance in sqlite
  const dist = db.prepare('SELECT vec_distance_cosine(?, ?) as d').get(embeddingToBlob(emb), yJob.embedding) as any;
  console.log('Distance between stored job embedding and newly generated job embedding:', dist?.d);

  // Check distance to profile embedding
  const prof = db.prepare('SELECT embedding FROM my_profile WHERE id = 1').get() as any;
  const profDist = db.prepare('SELECT vec_distance_cosine(?, ?) as d').get(prof.embedding, yJob.embedding) as any;
  console.log('Distance to default profile embedding:', profDist?.d);
}

test().catch(console.error);
