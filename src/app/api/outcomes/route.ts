import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getActiveOwnerId } from '@/lib/apply/screening-owner';

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

    const activeOwner = getActiveOwnerId();
    const existing = db
      .prepare('SELECT id, status FROM my_applications WHERE job_id = ? AND (owner_id = ? OR owner_id IS NULL)')
      .get(targetJobId, activeOwner) as ExistingApp | undefined;

    const now = new Date().toISOString();
    const today = applied_date || now.slice(0, 10);

    if (existing) {
      db.prepare(
        `UPDATE my_applications
         SET status = ?,
             owner_id = COALESCE(owner_id, ?),
             notes = COALESCE(?, notes),
             recruiter_name = COALESCE(?, recruiter_name),
             recruiter_contact = COALESCE(?, recruiter_contact),
             next_follow_up_at = COALESCE(?, next_follow_up_at),
             applied_date = COALESCE(?, applied_date),
             resume_source = COALESCE(?, resume_source),
             last_status_change_at = ?,
             applied_at = COALESCE(applied_at, ?)
         WHERE id = ?`
      ).run(
        status,
        activeOwner,
        notes ?? null,
        recruiter_name ?? null,
        recruiter_contact ?? null,
        next_follow_up_at ?? null,
        today,
        resume_source ?? null,
        now,
        now,
        existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO my_applications
          (job_id, owner_id, status, notes, recruiter_name, recruiter_contact, next_follow_up_at, applied_date, applied_at, last_status_change_at, resume_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        targetJobId,
        activeOwner,
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

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const reqOwner = searchParams.get('owner');
    const showAll = searchParams.get('all') === '1' || searchParams.get('scope') === 'all';
    const activeOwner = getActiveOwnerId();
    const targetOwner = showAll ? null : (reqOwner?.toLowerCase().trim() || activeOwner);

    const query = `
      SELECT a.*,
             CASE WHEN a.resume_source = 'original' THEN NULL ELSE COALESCE(a.tailored_score, d.tailored_score) END AS tailored_score,
             COALESCE(a.default_score, d.default_score) AS default_score,
             COALESCE(j.company, 'Unknown Company') as company,
             COALESCE(j.title, 'Job Application') as title,
             j.location, j.url,
             CASE WHEN a.resume_source = 'original' THEN 0
                  WHEN (a.resume_tex IS NOT NULL OR a.resume_variant IS NOT NULL OR d.resume_tex IS NOT NULL OR d.resume_variant IS NOT NULL)
                  THEN 1 ELSE 0 END AS has_tailored_resume
      FROM my_applications a
      LEFT JOIN job_postings j ON a.job_id = j.id
      LEFT JOIN job_documents d ON a.job_id = d.job_id
      ${targetOwner ? 'WHERE (a.owner_id = ? OR (a.owner_id IS NULL AND ? = \'default\'))' : ''}
      ORDER BY 
        REPLACE(COALESCE(a.applied_at, a.submitted_at, a.last_status_change_at, a.applied_date), ' ', 'T') DESC,
        a.id DESC
    `;

    const applications = (targetOwner
      ? db.prepare(query).all(targetOwner, targetOwner)
      : db.prepare(query).all()) as Record<string, any>[];

    // Ensure default_score is resolved for all applications if missing
    for (const app of applications) {
      if (app.default_score == null && app.job_id) {
        try {
          const { getRankedMatchById } = await import('@/lib/matches');
          const match = getRankedMatchById(
            { includeHidden: true, includeExpired: true, includeApplied: true, includeJobId: app.job_id },
            app.job_id,
          );
          if (match && match.finalScore != null) {
            app.default_score = Math.round(match.finalScore * 100);
            db.prepare('UPDATE my_applications SET default_score = ? WHERE id = ? AND default_score IS NULL').run(
              app.default_score,
              app.id,
            );
          }
        } catch {
          // ignore lookup errors
        }
      }
    }

    return NextResponse.json({ applications, activeOwner });
  } catch (error) {
    console.error('Fetch applications error:', error);
    return NextResponse.json({ error: 'Failed to fetch applications' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const activeOwner = getActiveOwnerId();
    const { jobIds, clearAll } = body;

    if (clearAll) {
      const deleted = db.prepare('DELETE FROM my_applications WHERE owner_id = ?').run(activeOwner);
      try {
        const { invalidateMatchCache } = await import('@/lib/matches');
        invalidateMatchCache();
      } catch {}
      return NextResponse.json({ success: true, count: deleted.changes });
    }

    if (Array.isArray(jobIds) && jobIds.length > 0) {
      const placeholders = jobIds.map(() => '?').join(',');
      const deleted = db
        .prepare(`DELETE FROM my_applications WHERE job_id IN (${placeholders}) AND (owner_id = ? OR owner_id IS NULL)`)
        .run(...jobIds, activeOwner);
      try {
        const { invalidateMatchCache } = await import('@/lib/matches');
        for (const jid of jobIds) {
          invalidateMatchCache(jid, { applied: false });
        }
      } catch {}
      return NextResponse.json({ success: true, count: deleted.changes });
    }

    return NextResponse.json({ error: 'Provide jobIds array or clearAll: true' }, { status: 400 });
  } catch (error) {
    console.error('Delete applications error:', error);
    return NextResponse.json({ error: 'Failed to delete applications' }, { status: 500 });
  }
}
