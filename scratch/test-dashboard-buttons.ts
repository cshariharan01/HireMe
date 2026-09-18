import db from '@/lib/db';
import { POST as hidePost, DELETE as hideDelete } from '@/app/api/jobs/[id]/hide/route';
import { POST as outcomesPost } from '@/app/api/outcomes/route';
import { buildMatchesPage } from '@/lib/matches-page';
import { getRankedMatches } from '@/lib/matches';
import { NextRequest } from 'next/server';

async function main() {
  console.log('--- TESTING REMOVE FROM DASHBOARD & MARK AS APPLIED ---');

  // Find a job that currently appears in the matches feed
  const initialFeed = buildMatchesPage({ offset: 0, limit: 10 });
  console.log('Initial feed match count:', initialFeed.matches.length);
  if (initialFeed.matches.length === 0) {
    console.log('No matches in feed! Checking why...');
    const pool = getRankedMatches({ includeHidden: false, includeExpired: false });
    console.log('Pool size:', pool?.ranked.length);
    return;
  }

  const testJob = initialFeed.matches[0];
  console.log(`Test Job: ID=${testJob.id}, Title="${testJob.title}", Company="${testJob.company}"`);

  // 1. TEST HIDE (Remove from dashboard)
  console.log('\n--- 1. Testing Remove from Dashboard (Hide) ---');
  const hideReq = new Request(`http://localhost:3000/api/jobs/${testJob.id}/hide`, { method: 'POST' });
  const hideRes = await hidePost(hideReq, { params: Promise.resolve({ id: String(testJob.id) }) });
  console.log('Hide response status:', hideRes.status);
  const hideJson = await hideRes.json();
  console.log('Hide response body:', hideJson);

  // Check DB directly
  const dbJobAfterHide = db.prepare('SELECT id, hidden_at FROM job_postings WHERE id = ?').get(testJob.id) as any;
  console.log('DB hidden_at after hide:', dbJobAfterHide?.hidden_at);

  // Check if buildMatchesPage now excludes the hidden job
  const feedAfterHide = buildMatchesPage({ offset: 0, limit: 10 });
  const isStillInFeedAfterHide = feedAfterHide.matches.some(m => m.id === testJob.id);
  console.log('Is hidden job still in buildMatchesPage feed?', isStillInFeedAfterHide);
  if (isStillInFeedAfterHide) {
    console.error('BUG CONFIRMED: Hidden job is STILL in the feed after POST /api/jobs/[id]/hide!');
  } else {
    console.log('SUCCESS: Hidden job is excluded from feed.');
  }

  // Restore (unhide) so we can test Mark as Applied
  const unhideReq = new Request(`http://localhost:3000/api/jobs/${testJob.id}/hide`, { method: 'DELETE' });
  await hideDelete(unhideReq, { params: Promise.resolve({ id: String(testJob.id) }) });
  console.log('Unhid test job.');

  // 2. TEST MARK AS APPLIED
  console.log('\n--- 2. Testing Mark as Applied ---');
  const applyReq = new NextRequest('http://localhost:3000/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: testJob.id, status: 'applied' }),
  });

  const applyRes = await outcomesPost(applyReq);
  console.log('Apply response status:', applyRes.status);
  const applyJson = await applyRes.json();
  console.log('Apply response body:', applyJson);

  // Check DB directly
  const dbApp = db.prepare('SELECT id, job_id, status FROM my_applications WHERE job_id = ?').get(testJob.id) as any;
  console.log('DB application status:', dbApp?.status);

  // Check if buildMatchesPage excludes applied job
  const feedAfterApply = buildMatchesPage({ offset: 0, limit: 10 });
  const isStillInFeedAfterApply = feedAfterApply.matches.some(m => m.id === testJob.id);
  console.log('Is applied job still in getMatchesPage feed?', isStillInFeedAfterApply);
  if (isStillInFeedAfterApply) {
    console.error('BUG CONFIRMED: Applied job is STILL in the feed after Mark as Applied!');
  } else {
    console.log('SUCCESS: Applied job is excluded from feed.');
  }

  // Cleanup: delete from my_applications
  db.prepare('DELETE FROM my_applications WHERE job_id = ?').run(testJob.id);
  // Invalidate cache
  db.prepare('DELETE FROM match_cache').run();
  console.log('Cleaned up test application.');
}

main().catch(console.error);
