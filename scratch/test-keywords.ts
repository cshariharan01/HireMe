import db from '../src/lib/db';
import { extractJdKeywords } from '../src/lib/llm';

const job = db.prepare('SELECT title, description FROM job_postings WHERE id = 1000055').get() as any;
const kws = extractJdKeywords(job.description, job.title, 15);
console.log('Extracted keywords for Yantran:', kws);
