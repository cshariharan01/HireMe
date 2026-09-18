import Database from 'better-sqlite3';
import { isTargetDataRole, isSeniorityCompatible, isExperienceCompatible } from '../src/lib/target-job-filter';

const db = new Database('data/hiresignal.db');
const jobs = db.prepare('SELECT id, title, company, description, url FROM job_postings').all() as any[];

let passed = 0;
let seniorSkipped = 0;
let expSkipped = 0;
let nonTarget = 0;

for (const j of jobs) {
  if (!isTargetDataRole(j.title)) { nonTarget++; continue; }
  if (!isSeniorityCompatible(j.title)) { seniorSkipped++; continue; }
  if (!isExperienceCompatible(null, null, j.title + ' ' + (j.description || ''))) { expSkipped++; continue; }
  passed++;
}

console.log('Total jobs:', jobs.length);
console.log('Non-target roles:', nonTarget);
console.log('Senior / Lead titles skipped:', seniorSkipped);
console.log('Incompatible experience skipped (>4 YOE):', expSkipped);
console.log('Passed suitable jobs for 3+ YOE candidate:', passed);
