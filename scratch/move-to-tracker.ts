import db from '../src/lib/db';
import { promoteDocumentsToApplication } from '../src/lib/apply/documents';
import { invalidateMatchCache } from '../src/lib/matches';

for (const jobId of [17713, 17837]) {
  const exists = db.prepare('SELECT id FROM my_applications WHERE job_id = ?').get(jobId);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  if (!exists) {
    db.prepare(`
      INSERT INTO my_applications (
        job_id, status, applied_date, applied_at,
        submitted_via, submitted_at, last_status_change_at, resume_source
      ) VALUES (?, 'applied', ?, ?, 'linkedin', ?, ?, 'tailored')
    `).run(jobId, today, now, now, now);
    promoteDocumentsToApplication(jobId);
    invalidateMatchCache(jobId, { applied: true, applicationStatus: 'applied' });
    console.log('Moved to tracker:', jobId);
  } else {
    console.log('Already in tracker:', jobId);
  }
}
