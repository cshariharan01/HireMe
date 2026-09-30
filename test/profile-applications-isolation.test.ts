import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import db from '@/lib/db';
import { GET as outcomesGet, POST as outcomesPost } from '@/app/api/outcomes/route';
import { GET as statsGet } from '@/app/api/stats/route';
import { NextRequest } from 'next/server';
import { getActiveOwnerId } from '@/lib/apply/screening-owner';
import { invalidateMatchCache } from '@/lib/matches';

describe('Profile Applications Isolation & Tracker Scoping', () => {
  let origProfileJson: string | null = null;
  const testJobId1 = 999901;
  const testJobId2 = 999902;

  beforeAll(() => {
    // Save original active profile
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as { parsed_json: string } | undefined;
    origProfileJson = row?.parsed_json ?? null;

    // Seed two test jobs
    db.prepare(`
      INSERT OR REPLACE INTO job_postings (id, company, title, location, url, source, apply_type)
      VALUES (?, 'TestCo A', 'Software Engineer', 'Remote', 'https://example.com/1', 'manual', 'direct_apply'),
             (?, 'TestCo B', 'Backend Engineer', 'Remote', 'https://example.com/2', 'manual', 'direct_apply')
    `).run(testJobId1, testJobId2);
  });

  afterAll(() => {
    // Restore original active profile
    if (origProfileJson) {
      db.prepare('UPDATE my_profile SET parsed_json = ? WHERE id = 1').run(origProfileJson);
    }
    // Clean up test jobs & test applications
    db.prepare('DELETE FROM my_applications WHERE job_id IN (?, ?)').run(testJobId1, testJobId2);
    db.prepare('DELETE FROM job_postings WHERE id IN (?, ?)').run(testJobId1, testJobId2);
    invalidateMatchCache();
  });

  it('isolates applications between Candidate A and Candidate B', async () => {
    // 1. Set Candidate A as active
    const candidateA = {
      name: 'Alice Candidate',
      email: 'alice@testexample.com',
      skills: ['TypeScript', 'React'],
    };
    db.prepare('UPDATE my_profile SET parsed_json = ? WHERE id = 1').run(JSON.stringify(candidateA));
    expect(getActiveOwnerId()).toBe('alice@testexample.com');

    // Candidate A applies to Job 1
    const applyReqA = new NextRequest('http://localhost:3000/api/outcomes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: testJobId1, status: 'applied', notes: 'Alice applied' }),
    });
    const applyResA = await outcomesPost(applyReqA);
    expect(applyResA.status).toBe(200);

    // Verify application stored with owner_id = alice@testexample.com
    const appRowA = db.prepare('SELECT job_id, owner_id, status FROM my_applications WHERE job_id = ?').get(testJobId1) as any;
    expect(appRowA.owner_id).toBe('alice@testexample.com');
    expect(appRowA.status).toBe('applied');

    // Candidate A's outcomes endpoint returns Job 1
    const getReqA = new NextRequest('http://localhost:3000/api/outcomes');
    const getResA = await outcomesGet(getReqA);
    const dataA = await getResA.json();
    const aliceJob1 = dataA.applications.find((a: any) => a.job_id === testJobId1);
    expect(aliceJob1).toBeDefined();

    // Stats for Alice reports appliedCount >= 1
    const statsResA = await statsGet();
    const statsDataA = await statsResA.json();
    expect(statsDataA.appliedCount).toBeGreaterThanOrEqual(1);

    // 2. Now switch active profile to Candidate B (brand new imported candidate)
    const candidateB = {
      name: 'Bob Newcomer',
      email: 'bob@testexample.com',
      skills: ['Python', 'SQL'],
    };
    db.prepare('UPDATE my_profile SET parsed_json = ? WHERE id = 1').run(JSON.stringify(candidateB));
    expect(getActiveOwnerId()).toBe('bob@testexample.com');

    // Bob's outcomes endpoint MUST NOT show Alice's Job 1!
    const getReqB = new NextRequest('http://localhost:3000/api/outcomes');
    const getResB = await outcomesGet(getReqB);
    const dataB = await getResB.json();
    const bobJob1 = dataB.applications.find((a: any) => a.job_id === testJobId1);
    expect(bobJob1).toBeUndefined(); // Alice's application is NOT visible to Bob!

    // Bob's stats reports appliedCount = 0 (for Bob)
    const statsResB = await statsGet();
    const statsDataB = await statsResB.json();
    expect(statsDataB.appliedCount).toBe(0);

    // Bob requests with ?all=1 or ?scope=all -> can view all applications if explicitly requested
    const getReqAll = new NextRequest('http://localhost:3000/api/outcomes?scope=all');
    const getResAll = await outcomesGet(getReqAll);
    const dataAll = await getResAll.json();
    const allJob1 = dataAll.applications.find((a: any) => a.job_id === testJobId1);
    expect(allJob1).toBeDefined();

    // 3. Bob applies to Job 2
    const applyReqB = new NextRequest('http://localhost:3000/api/outcomes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: testJobId2, status: 'applied', notes: 'Bob applied' }),
    });
    const applyResB = await outcomesPost(applyReqB);
    expect(applyResB.status).toBe(200);

    const appRowB = db.prepare('SELECT job_id, owner_id, status FROM my_applications WHERE job_id = ?').get(testJobId2) as any;
    expect(appRowB.owner_id).toBe('bob@testexample.com');

    // Bob now sees Job 2, but NOT Job 1
    const getReqB2 = new NextRequest('http://localhost:3000/api/outcomes');
    const getResB2 = await outcomesGet(getReqB2);
    const dataB2 = await getResB2.json();
    expect(dataB2.applications.some((a: any) => a.job_id === testJobId2)).toBe(true);
    expect(dataB2.applications.some((a: any) => a.job_id === testJobId1)).toBe(false);
  });
});
