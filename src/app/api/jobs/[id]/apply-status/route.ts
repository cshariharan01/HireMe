import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { getActiveApplyBrowser } from '@/lib/apply/launcher';
import { detectNaukriApplicationSubmitted, detectNaukriCaptcha, detectNaukriLoginRequired } from '@/lib/apply/naukri';
import { detectLinkedInApplicationSubmitted } from '@/lib/apply/linkedin';
import { getActiveOwnerId } from '@/lib/apply/screening-owner';

async function markJobAsApplied(jobId: number, strategy = 'manual') {
  try {
    const activeOwner = getActiveOwnerId();
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const existing = db
      .prepare('SELECT id FROM my_applications WHERE job_id = ? AND (owner_id = ? OR owner_id IS NULL)')
      .get(jobId, activeOwner) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE my_applications
         SET status = 'applied',
             owner_id = COALESCE(owner_id, ?),
             submitted_via = ?,
             submitted_at = ?,
             applied_at = ?,
             applied_date = ?,
             last_status_change_at = ?
         WHERE id = ?`
      ).run(activeOwner, strategy, now, now, today, now, existing.id);
    } else {
      db.prepare(
        `INSERT INTO my_applications (job_id, owner_id, status, submitted_via, submitted_at, applied_at, applied_date, last_status_change_at)
         VALUES (?, ?, 'applied', ?, ?, ?, ?, ?)`
      ).run(jobId, activeOwner, strategy, now, now, today, now);
    }

    try {
      const { promoteDocumentsToApplication } = await import('@/lib/apply/documents');
      promoteDocumentsToApplication(jobId);
    } catch {}

    try {
      const { invalidateMatchCache } = await import('@/lib/matches');
      invalidateMatchCache(jobId, { applied: true, applicationStatus: 'applied' });
    } catch {}

    try {
      const { calculateAndStoreTailoredScore } = await import('@/lib/tailored-score');
      await calculateAndStoreTailoredScore(jobId);
    } catch {}
  } catch (e) {
    console.warn('[apply-status] error marking job as applied:', e);
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const jobId = parseInt(params.id, 10);
    if (!jobId) return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 });

    const activeOwner = getActiveOwnerId();
    // 1. Check database for application row (scoped to active candidate)
    const appRow = db.prepare(
      "SELECT id, status, applied_date FROM my_applications WHERE job_id = ? AND (owner_id = ? OR (owner_id IS NULL AND ? = 'default')) AND status IN ('applied', 'screening', 'interview', 'offer')"
    ).get(jobId, activeOwner, activeOwner) as { id: number; status: string; applied_date: string } | undefined;

    if (appRow) {
      return NextResponse.json({
        status: 'submitted',
        appliedDate: appRow.applied_date,
        alreadyApplied: true,
      });
    }

    // 2. Check active Playwright browser session if open
    const ctx = await getActiveApplyBrowser();
    if (ctx && ctx.browser()?.isConnected()) {
      const pages = ctx.pages();
      for (const page of pages) {
        if (page.isClosed()) continue;
        const currentUrl = page.url ? page.url() : '';

        // Check Naukri
        if (currentUrl.includes('naukri.com')) {
          const submitted =
            (await detectNaukriApplicationSubmitted(page).catch(() => false)) ||
            currentUrl.includes('/myapply') ||
            currentUrl.includes('multiApplyResp') ||
            currentUrl.includes('saveApply');
          if (submitted) {
            await markJobAsApplied(jobId, 'naukri');
            return NextResponse.json({ status: 'submitted' });
          }
          if (await detectNaukriCaptcha(page).catch(() => false)) {
            return NextResponse.json({ status: 'captcha', error: 'CAPTCHA detected in Chrome window' });
          }
          if (await detectNaukriLoginRequired(page).catch(() => false)) {
            return NextResponse.json({ status: 'login_required', error: 'Login required in Chrome window' });
          }
        }

        // Check LinkedIn
        if (currentUrl.includes('linkedin.com')) {
          const submitted = await detectLinkedInApplicationSubmitted(page).catch(() => false);
          if (submitted) {
            await markJobAsApplied(jobId, 'linkedin');
            return NextResponse.json({ status: 'submitted' });
          }
        }
      }

      return NextResponse.json({ status: 'in_progress', readyForSubmit: true });
    }

    // 3. Check if an audit row for stopped_for_review exists
    const recentAudit = db.prepare(
      `SELECT strategy, attempted_at FROM apply_audit
       WHERE job_id = ? AND status = 'stopped_for_review'
       ORDER BY id DESC LIMIT 1`
    ).get(jobId) as { strategy: string; attempted_at: string } | undefined;

    if (recentAudit) {
      return NextResponse.json({ status: 'stopped_for_review', readyForSubmit: true });
    }

    return NextResponse.json({ status: 'not_submitted' });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Status check failed' }, { status: 500 });
  }
}
