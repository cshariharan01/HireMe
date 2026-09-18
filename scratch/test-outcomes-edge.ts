import db from '@/lib/db';
import { POST as outcomesPost } from '@/app/api/outcomes/route';
import { NextRequest } from 'next/server';

async function testOutcomesEdgeCases() {
  console.log('=== TESTING OUTCOMES EDGE CASES ===\n');

  // Case 1: jobId as string vs number vs undefined
  console.log('--- Test 1: jobId as string ---');
  const job = db.prepare('SELECT id, title, company FROM job_postings LIMIT 1').get() as any;
  
  const req1 = new NextRequest('http://localhost:3000/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: String(job.id), status: 'applied' }),
  });
  const res1 = await outcomesPost(req1);
  console.log('Status with string jobId:', res1.status);

  console.log('\n--- Test 2: jobId as undefined (e.g. Number(undefined) -> null) ---');
  const req2 = new NextRequest('http://localhost:3000/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: null, status: 'applied' }),
  });
  const res2 = await outcomesPost(req2);
  console.log('Status with null jobId:', res2.status);
  const json2 = await res2.json();
  console.log('Error message with null jobId:', json2.error);

  console.log('\n--- Test 3: What if job has tailored resume variant? ---');
  // Check if calculateAndStoreTailoredScore delays the response
  // Insert a mock document
  db.prepare('INSERT OR REPLACE INTO job_documents (job_id, resume_variant) VALUES (?, ?)').run(job.id, 'Experienced Senior Engineer with Python, React');
  const t0 = Date.now();
  const req3 = new NextRequest('http://localhost:3000/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: job.id, status: 'applied' }),
  });
  const res3 = await outcomesPost(req3);
  const dur = Date.now() - t0;
  console.log(`Status with document: ${res3.status}, duration: ${dur}ms`);
  const json3 = await res3.json();
  console.log('Response body:', json3);

  // Clean up
  db.prepare('DELETE FROM my_applications WHERE job_id = ?').run(job.id);
  db.prepare('DELETE FROM job_documents WHERE job_id = ?').run(job.id);
  db.prepare('DELETE FROM match_cache').run();
}

testOutcomesEdgeCases().catch(console.error);
