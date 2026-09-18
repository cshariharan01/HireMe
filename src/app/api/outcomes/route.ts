import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

interface ExistingApp {
  id: number;
  status: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { jobId, company, title, location, url, status, notes, recruiter_name, recruiter_contact, next_follow_up_at, applied_date, resume_source } = body;

    if (!status) {
      return NextResponse.json({ error: 'status is required' }, { status: 400 });
    }

    let targetJobId = jobId ? Number(jobId) : null;
    if (!targetJobId) {
      if (!company?.trim() || !title?.trim()) {
        return NextResponse.json({ error: 'Either jobId or both company and title are required' }, { status: 400 });
      }
      const manualJob = db.prepare(`
        INSERT INTO job_postings (company, title, location, url, source, apply_type, ingested_at)
        VALUES (?, ?, ?, ?, 'manual', 'direct_apply', CURRENT_TIMESTAMP)
      `).run(company.trim(), title.trim(), location?.trim() || null, url?.trim() || null);
      targetJobId = Number(manualJob.lastInsertRowid);
    }

    const validStatuses = ['applied', 'screening', 'interview', 'offer', 'rejected'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    const existing = db
      .prepare('SELECT id, status FROM my_applications WHERE job_id = ?')
      .get(targetJobId) as ExistingApp | undefined;

    const now = new Date().toISOString();
    const today = applied_date || now.slice(0, 10);

    if (existing) {
      db.prepare(
        `UPDATE my_applications
         SET status = ?,
             notes = COALESCE(?, notes),
             recruiter_name = COALESCE(?, recruiter_name),
             recruiter_contact = COALESCE(?, recruiter_contact),
             next_follow_up_at = COALESCE(?, next_follow_up_at),
             applied_date = COALESCE(?, applied_date),
             resume_source = COALESCE(?, resume_source),
             last_status_change_at = ?,
             applied_at = COALESCE(applied_at, ?)
         WHERE job_id = ?`
      ).run(
        status,
        notes ?? null,
        recruiter_name ?? null,
        recruiter_contact ?? null,
        next_follow_up_at ?? null,
        today,
        resume_source ?? null,
        now,
        now,
        targetJobId
      );
    } else {
      db.prepare(
        `INSERT INTO my_applications
          (job_id, status, notes, recruiter_name, recruiter_contact, next_follow_up_at, applied_date, applied_at, last_status_change_at, resume_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        targetJobId,
        status,
        notes ?? null,
        recruiter_name ?? null,
        recruiter_contact ?? null,
        next_follow_up_at ?? null,
        today,
        now,
        now,
        resume_source ?? 'tailored'
      );
    }

    try {
      // Promote any cached tailored resume / cover letter into my_applications
      const { promoteDocumentsToApplication } = await import('@/lib/apply/documents');
      promoteDocumentsToApplication(targetJobId);
    } catch {
      // Ignore if document promotion fails
    }

    try {
      // Invalidate match_cache immediately so the matches dashboard excludes the applied job without delay
      const { invalidateMatchCache } = await import('@/lib/matches');
      invalidateMatchCache(targetJobId, { applied: true, applicationStatus: status });
    } catch (e) {
      console.warn('[outcomes] match cache invalidation error:', e);
    }

    // Automatically calculate and store tailored match score in the background without blocking response
    import('@/lib/tailored-score')
      .then(({ calculateAndStoreTailoredScore }) => calculateAndStoreTailoredScore(targetJobId))
      .catch((e) => console.warn('[outcomes] auto tailored score error:', e));

    return NextResponse.json({ success: true, jobId: targetJobId });
  } catch (error) {
    console.error('Outcome update error:', error);
    const msg = error instanceof Error ? error.message : '';
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update outcome' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const applications = db
      .prepare(
        `SELECT a.*,
                COALESCE(a.tailored_score, d.tailored_score) AS tailored_score,
                COALESCE(a.default_score, d.default_score) AS default_score,
                COALESCE(j.company, 'Unknown Company') as company,
                COALESCE(j.title, 'Job Application') as title,
                j.location, j.url,
                CASE WHEN (a.resume_tex IS NOT NULL OR a.resume_variant IS NOT NULL OR d.resume_tex IS NOT NULL OR d.resume_variant IS NOT NULL)
                     THEN 1 ELSE 0 END AS has_tailored_resume
         FROM my_applications a
         LEFT JOIN job_postings j ON a.job_id = j.id
         LEFT JOIN job_documents d ON a.job_id = d.job_id
         ORDER BY 
           REPLACE(COALESCE(a.applied_at, a.submitted_at, a.last_status_change_at, a.applied_date), ' ', 'T') DESC,
           a.id DESC`
      )
      .all();

    return NextResponse.json({ applications });
  } catch (error) {
    console.error('Fetch applications error:', error);
    return NextResponse.json({ error: 'Failed to fetch applications' }, { status: 500 });
  }
}
