async function testLiveEndpoints() {
  console.log('=== TESTING LIVE HTTP ENDPOINTS ON http://localhost:3000 ===\n');

  // 1. Fetch current matches
  const matchesRes = await fetch('http://localhost:3000/api/matches?offset=0&limit=10');
  const matchesData = await matchesRes.json();
  console.log(`Fetched matches: ${matchesData.matches?.length || 0}`);
  if (!matchesData.matches || matchesData.matches.length === 0) {
    console.error('No matches returned from /api/matches');
    return;
  }

  const job = matchesData.matches[0];
  console.log(`Target Job: [${job.id}] "${job.title}" at "${job.company}"`);

  // 2. Test Hide (Remove from dashboard)
  console.log('\n--- Step 1: POST /api/jobs/${job.id}/hide ---');
  const hideRes = await fetch(`http://localhost:3000/api/jobs/${job.id}/hide`, { method: 'POST' });
  console.log(`Hide response status: ${hideRes.status}`);
  const hideJson = await hideRes.json();
  console.log(`Hide response:`, hideJson);

  // 3. Immediately re-fetch matches (simulating revalidateMatches in SWR)
  console.log('\n--- Step 2: Fetch /api/matches immediately after hide (simulating SWR revalidation) ---');
  const afterHideRes = await fetch('http://localhost:3000/api/matches?offset=0&limit=10');
  const afterHideData = await afterHideRes.json();
  const foundAfterHide = afterHideData.matches?.some((m: any) => m.id === job.id);
  console.log(`Is hidden job [${job.id}] still in /api/matches? -> ${foundAfterHide}`);
  if (foundAfterHide) {
    console.error('CRITICAL BUG: Job was NOT removed from /api/matches after POST /api/jobs/[id]/hide!');
  } else {
    console.log('SUCCESS: Job was properly excluded from /api/matches');
  }

  // Restore the job so we can test Mark as Applied
  console.log('\n--- Restoring job via DELETE /api/jobs/${job.id}/hide ---');
  await fetch(`http://localhost:3000/api/jobs/${job.id}/hide`, { method: 'DELETE' });

  // 4. Test Mark as Applied
  console.log('\n--- Step 3: POST /api/outcomes with status="applied" ---');
  const t0 = Date.now();
  const applyRes = await fetch('http://localhost:3000/api/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: job.id, status: 'applied' }),
  });
  const duration = Date.now() - t0;
  console.log(`Mark as applied status: ${applyRes.status} (took ${duration}ms)`);
  const applyJson = await applyRes.json();
  console.log('Apply response:', applyJson);

  // 5. Check /api/matches after Mark as Applied
  console.log('\n--- Step 4: Fetch /api/matches after Mark as Applied ---');
  const afterApplyRes = await fetch('http://localhost:3000/api/matches?offset=0&limit=10');
  const afterApplyData = await afterApplyRes.json();
  const foundAfterApply = afterApplyData.matches?.some((m: any) => m.id === job.id);
  console.log(`Is applied job [${job.id}] still in /api/matches? -> ${foundAfterApply}`);

  // 6. Check /api/stats applied count
  const statsRes = await fetch('http://localhost:3000/api/stats');
  const statsData = await statsRes.json();
  console.log('Stats after applied:', statsData);

  // Cleanup: delete from outcomes
  const cleanupRes = await fetch(`http://localhost:3000/api/outcomes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: job.id, status: 'applied' }),
  });
  // Clean up directly in SQLite
  const db = (await import('@/lib/db')).default;
  db.prepare('DELETE FROM my_applications WHERE job_id = ?').run(job.id);
  db.prepare('DELETE FROM match_cache').run();
  console.log('\nCleaned up test application.');
}

testLiveEndpoints().catch(console.error);
