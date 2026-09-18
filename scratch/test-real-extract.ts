import db from '../src/lib/db';
import { extractPostingFacts } from '../src/lib/posting-facts';
import { isExperienceCompatible } from '../src/lib/target-job-filter';

const jobs = db.prepare('SELECT id, title, location, description, url FROM job_postings WHERE id IN (18053, 18066, 18082, 17917, 17668, 18090, 18054, 18060)').all();

for (const j of jobs) {
  const facts = extractPostingFacts(j.description || '', j.location || '', j.title || '', j.url || '');
  const compatible = isExperienceCompatible(facts.experienceMin, facts.experienceMax, `${j.title} ${j.url} ${facts.experienceText ?? ''}`, 3.6);
  console.log(`Job ${j.id}: "${j.title}"`);
  console.log(`  facts: min=${facts.experienceMin}, max=${facts.experienceMax}, text="${facts.experienceText}"`);
  console.log(`  compatible with 3.6 years? -> ${compatible}`);
}
