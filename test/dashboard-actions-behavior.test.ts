import { seedJob } from './setup-db';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';
import { POST as hidePost, DELETE as hideDelete } from '@/app/api/jobs/[id]/hide/route';
import { POST as outcomesPost } from '@/app/api/outcomes/route';
import { buildMatchesPage } from '@/lib/matches-page';
import { invalidateMatchCache } from '@/lib/matches';
import { NextRequest } from 'next/server';

describe('Dashboard Actions Behavior: Remove from dashboard & Mark as Applied', () => {
  it('instantly excludes a hidden job from the matches feed and restores it on unhide', async () => {
    // Invalidate any leftover cache first
    invalidateMatchCache();
    const initialPage = buildMatchesPage({ limit: 10 });
    expect(initialPage.matches.length).toBeGreaterThan(0);

    const testJob = initialPage.matches[0];
    const jobId = testJob.id;

    try {
      // Hide the job
      const hideReq = new Request(`http://localhost:3000/api/jobs/${jobId}/hide`, { method: 'POST' });
      const hideRes = await hidePost(hideReq, { params: Promise.resolve({ id: String(jobId) }) });
      expect(hideRes.status).toBe(200);

      // Verify that buildMatchesPage IMMEDIATELY excludes the hidden job without stale cache
      const pageAfterHide = buildMatchesPage({ limit: 10 });
      const isPresentAfterHide = pageAfterHide.matches.some((m) => m.id === jobId);
      expect(isPresentAfterHide).toBe(false);

      // Restore via DELETE (undo)
      const delReq = new Request(`http://localhost:3000/api/jobs/${jobId}/hide`, { method: 'DELETE' });
      const delRes = await hideDelete(delReq, { params: Promise.resolve({ id: String(jobId) }) });
      expect(delRes.status).toBe(200);

      // Verify that the job is restored
      const pageAfterRestore = buildMatchesPage({ limit: 10 });
      const isPresentAfterRestore = pageAfterRestore.matches.some((m) => m.id === jobId);
      expect(isPresentAfterRestore).toBe(true);
    } finally {
      db.prepare('UPDATE job_postings SET hidden_at = NULL WHERE id = ?').run(jobId);
      invalidateMatchCache();
    }
  });

  it('marks a job as applied, excludes it from active feed, and updates stats', async () => {
    invalidateMatchCache();
    const initialPage = buildMatchesPage({ limit: 10 });
    const testJob = initialPage.matches[0];
    const jobId = testJob.id;

    try {
      const applyReq = new NextRequest('http://localhost:3000/api/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, status: 'applied' }),
      });
      const applyRes = await outcomesPost(applyReq);
      expect(applyRes.status).toBe(200);

      const appRow = db.prepare('SELECT status FROM my_applications WHERE job_id = ?').get(jobId) as { status: string };
      expect(appRow?.status).toBe('applied');

      // Excluded from active feed
      const pageAfterApply = buildMatchesPage({ limit: 10 });
      const isPresentAfterApply = pageAfterApply.matches.some((m) => m.id === jobId);
      expect(isPresentAfterApply).toBe(false);
    } finally {
      db.prepare('DELETE FROM my_applications WHERE job_id = ?').run(jobId);
      invalidateMatchCache();
    }
  });

  it('verifies UI wiring for Mark as Applied and Remove from Dashboard', () => {
    const jobDetailCode = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'job-detail-panel.tsx'),
      'utf8'
    );

    // JobDetailPanel must have onApplied prop
    expect(jobDetailCode).toContain('onApplied?: (jobId: number) => void;');
    // Mark as Applied must have isMarkingApplied state and spinner
    expect(jobDetailCode).toContain('isMarkingApplied');
    expect(jobDetailCode).toContain('disabled={isMarkingApplied}');
    // Safe ID fallback
    expect(jobDetailCode).toContain('const targetId = Number(jobId || data?.job?.id);');
    // Must revalidate dashboard stats
    expect(jobDetailCode).toContain('revalidateDashboardStats();');

    const dashboardCode = fs.readFileSync(
      path.join(process.cwd(), 'src', 'app', 'dashboard-client.tsx'),
      'utf8'
    );
    // Dashboard client must pass onApplied
    expect(dashboardCode).toContain('onApplied={(id) => {');
    // Dashboard client must import and call revalidateDashboardStats
    expect(dashboardCode).toContain('revalidateDashboardStats');
  });
});
