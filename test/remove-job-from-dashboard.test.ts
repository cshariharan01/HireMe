import { seedJob } from './setup-db';
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';
import { POST, DELETE } from '@/app/api/jobs/[id]/hide/route';

describe('Remove from Dashboard (hide/unhide) API and UI integration', () => {
  it('hides a job via POST /api/jobs/[id]/hide and restores via DELETE', async () => {
    const jobId = seedJob(db, { title: 'Test Engineer', company: 'Test Corp' });

    try {
      // Initially hidden_at is null
      const initialRow = db.prepare('SELECT hidden_at FROM job_postings WHERE id = ?').get(jobId) as { hidden_at: string | null };
      expect(initialRow.hidden_at).toBeNull();

      // Call POST to hide
      const postReq = new Request(`http://localhost:3000/api/jobs/${jobId}/hide`, { method: 'POST' });
      const postRes = await POST(postReq, { params: Promise.resolve({ id: String(jobId) }) });
      expect(postRes.status).toBe(200);

      const hiddenRow = db.prepare('SELECT hidden_at FROM job_postings WHERE id = ?').get(jobId) as { hidden_at: string | null };
      expect(hiddenRow.hidden_at).not.toBeNull();

      // Call DELETE to restore (undo)
      const delReq = new Request(`http://localhost:3000/api/jobs/${jobId}/hide`, { method: 'DELETE' });
      const delRes = await DELETE(delReq, { params: Promise.resolve({ id: String(jobId) }) });
      expect(delRes.status).toBe(200);

      const restoredRow = db.prepare('SELECT hidden_at FROM job_postings WHERE id = ?').get(jobId) as { hidden_at: string | null };
      expect(restoredRow.hidden_at).toBeNull();
    } finally {
      db.prepare('DELETE FROM job_postings WHERE id = ?').run(jobId);
    }
  });

  it('verifies that JobDetailPanel has the dedicated Remove from Dashboard button next to Mark as Applied', () => {
    const code = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'job-detail-panel.tsx'), 'utf8');

    // Must have Trash2 icon
    expect(code).toContain('Trash2');

    // Must have the dedicated button with "Remove from Dashboard"
    expect(code).toContain('Remove from Dashboard');

    // Must have "Mark as Applied" followed by "Remove from Dashboard" in the action bar
    const markAsAppliedIdx = code.indexOf('Mark as Applied');
    const removeIdx = code.indexOf('Remove from Dashboard', markAsAppliedIdx);
    expect(markAsAppliedIdx).toBeGreaterThan(0);
    expect(removeIdx).toBeGreaterThan(markAsAppliedIdx);
    // Should be adjacent (within reasonable proximity in the action bar)
    expect(removeIdx - markAsAppliedIdx).toBeLessThan(1000);
  });

  it('verifies that dashboard-client wires onHide to JobDetailPanel', () => {
    const code = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'dashboard-client.tsx'), 'utf8');
    expect(code).toContain('onHide={(id) => {');
    expect(code).toContain('Removed "');
    expect(code).toContain('from dashboard');
  });
});
