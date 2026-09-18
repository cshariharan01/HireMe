import { NextRequest, NextResponse } from 'next/server';
import { promoteDocumentsToApplication } from '@/lib/apply/documents';
import db from '@/lib/db';
import { prepareSubmission, checkRateLimit, type SubmissionPlan, type BrowserSubmissionPlan } from '@/lib/apply/prepare';
import { submitGreenhouse } from '@/lib/apply/greenhouse';
import { submitAshby } from '@/lib/apply/ashby';
import { browserAutofill } from '@/lib/apply/browser';
import { linkedInApply } from '@/lib/apply/linkedin';
import { naukriApply } from '@/lib/apply/naukri';
import { getApplyConfig } from '@/lib/apply/questions';
import { isApplyCancelled, resetApplyCancellation } from '@/lib/apply/launcher';

// GET /api/jobs/[id]/apply — preview: returns the SubmissionPlan for the UI modal.
// Includes the strategy detected, all fields the portal asks for (with our planned answers),
// and any warnings (missing profile fields, fields where we couldn't guess an answer, etc.)
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const jobId = parseInt(params.id, 10);
    if (!jobId) return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 });

    const rs = new URL(_req.url).searchParams.get('resume');
    const regen = new URL(_req.url).searchParams.get('regenerate');
    const forceRegenerate = regen === 'true' || regen === '1';
    const resumeSource = rs === 'original' || rs === 'tailored' ? rs : undefined;
    const config = getApplyConfig();
    const effectiveResumeSource = resumeSource || (config.resumeSource as 'original' | 'tailored') || 'tailored';

    // Fast initial preview: load cached documents immediately so the dialog opens in milliseconds.
    // If a tailored document is already cached, include it.
    // Only block on a fresh LLM generation during preview if explicitly requested via `?regenerate=true`.
    const hasCachedTailored = !!(
      db.prepare('SELECT 1 FROM job_documents WHERE job_id = ? AND (resume_variant IS NOT NULL OR resume_tex IS NOT NULL)').get(jobId) ||
      db.prepare('SELECT 1 FROM my_applications WHERE job_id = ? AND (resume_variant IS NOT NULL OR resume_tex IS NOT NULL)').get(jobId)
    );
    const generateMissing = forceRegenerate || (effectiveResumeSource === 'tailored' && hasCachedTailored);
    const result = await prepareSubmission(jobId, {
      resumeSource: effectiveResumeSource,
      generateMissing,
      forceRegenerate,
    });
    if (!result.ok || !result.plan) {
      return NextResponse.json({
        ok: false,
        strategy: result.strategy,
        warnings: result.warnings,
        error: result.error,
      }, { status: 200 });  // 200 because "not auto-appliable" is normal, not an error
    }

    // Don't serialize the actual file bytes — just metadata. The UI doesn't need bytes
    // for the preview. On confirm, the route re-renders the PDF.
    // Normalize field shape: dialog expects `name` (Greenhouse) but Ashby uses `path`.
    // Same idea, different label. Map both to a common `{name, type, label, required, value, ...}`.
    const normalizedFields = result.plan.strategy === 'ashby'
      ? result.plan.fields.map((f) => ({
          name: f.path,
          type: f.type,
          label: f.label,
          required: f.required,
          // For the UI, display the human string. The actual structured value is
          // re-derived from the plan at submit time, not from what we serialize here.
          value: f.display || null,
          warning: f.warning,
          source: f.source,
          category: f.category,
        }))
      : result.plan.fields;
    // Pull cover-letter markdown so the dialog can preview it inline (the attachments
    // section otherwise only shows filename + size, which doesn't tell the user what's actually being sent).
    const coverLetterBytes = result.plan.attachments.coverLetter?.bytes;
    const coverLetterMarkdown = coverLetterBytes
      ? new TextDecoder().decode(coverLetterBytes)
      : null;

    // Resume markdown — we don't ship the PDF bytes; the user can open
    // /api/jobs/[id]/resume.pdf in a new tab to view the rendered PDF.
    const planForUi = {
      ...result.plan,
      fields: normalizedFields,
      attachments: {
        resume: result.plan.attachments.resume ? {
          filename: result.plan.attachments.resume.filename,
          mimeType: result.plan.attachments.resume.mimeType,
          sizeBytes: result.plan.attachments.resume.bytes.length,
        } : null,
        coverLetter: result.plan.attachments.coverLetter ? {
          filename: result.plan.attachments.coverLetter.filename,
          mimeType: result.plan.attachments.coverLetter.mimeType,
          sizeBytes: result.plan.attachments.coverLetter.bytes.length,
        } : null,
      },
    };

    // Check if job is already applied
    const alreadyAppliedRow = db.prepare(
      "SELECT id, status, applied_date FROM my_applications WHERE job_id = ? AND status IN ('applied', 'screening', 'interview', 'offer')"
    ).get(jobId) as { id: number; status: string; applied_date: string } | undefined;

    return NextResponse.json({
      ok: true,
      alreadyApplied: !!alreadyAppliedRow,
      appliedDate: alreadyAppliedRow?.applied_date,
      strategy: result.strategy,
      plan: planForUi,
      coverLetterMarkdown,
      warnings: (result.warnings || []).filter(
        (w) => w.code !== 'cover_letter_pending' && w.code !== 'resume_variant_pending',
      ),
      resumeSource: result.resumeSource,
      resumeSourceAvailable: result.resumeSourceAvailable,
      tailoredReady: !!(result.hasTailored || hasCachedTailored),
    });
  } catch (error) {
    console.error('Apply preview error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}

// POST /api/jobs/[id]/apply — execute the submission.
// Body (optional): { overrides?: { [fieldName: string]: any } } — user-edited values from the preview
// Query: ?dry_run=1 forces dry-run regardless of config
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const jobId = parseInt(params.id, 10);
    if (!jobId) return NextResponse.json({ error: 'Invalid jobId' }, { status: 400 });

    const reqStartTime = Date.now();
    resetApplyCancellation();

    const url = new URL(req.url);
    const dryRunQuery = url.searchParams.get('dry_run') === '1';
    const autoSubmitQuery = url.searchParams.get('auto_submit') === '1' || url.searchParams.get('auto_submit') === 'true';
    const config = getApplyConfig();
    const dryRun = dryRunQuery || config.dryRun || process.env.APPLY_DRY_RUN === '1';

    // Prevent duplicate applications: don't auto-apply again if already applied
    if (!dryRun) {
      const alreadyApplied = db.prepare(
        "SELECT id, status, applied_date FROM my_applications WHERE job_id = ? AND status IN ('applied', 'screening', 'interview', 'offer')"
      ).get(jobId) as { id: number; status: string; applied_date: string } | undefined;

      if (alreadyApplied) {
        return NextResponse.json({
          ok: false,
          alreadyApplied: true,
          error: `This job was already applied to on ${alreadyApplied.applied_date || 'a previous date'} and is in your Tracker.`,
        }, { status: 409 });
      }
    }

    if (isApplyCancelled(reqStartTime) || req.signal.aborted) {
      return NextResponse.json({ ok: false, error: 'Apply cancelled by user' }, { status: 499 });
    }

    const body = await req.json().catch(() => ({}));
    const autoSubmit = autoSubmitQuery || body.autoSubmit === true;
    const overrides = (body.overrides || {}) as Record<string, unknown>;
    const resumeSource = body.resumeSource === 'original' || body.resumeSource === 'tailored' ? body.resumeSource : undefined;

    // Re-prepare the plan so we have fresh PDF bytes + a fresh schema snapshot
    const result = await prepareSubmission(jobId, { resumeSource });
    if (!result.ok || !result.plan) {
      return NextResponse.json({ ok: false, error: result.error, warnings: result.warnings }, { status: 400 });
    }

    if (isApplyCancelled(reqStartTime) || req.signal.aborted) {
      return NextResponse.json({ ok: false, error: 'Apply cancelled by user' }, { status: 499 });
    }

    // Rate-limit check (skipped on dry-run)
    if (!dryRun) {
      const rl = checkRateLimit(result.strategy);
      if (!rl.ok) {
        db.prepare(`INSERT INTO apply_audit (job_id, strategy, status, error) VALUES (?, ?, 'rate_limited', ?)`).run(jobId, result.strategy, rl.reason || 'Rate limited');
        return NextResponse.json({ ok: false, error: rl.reason, rateLimit: rl.counts }, { status: 429 });
      }
    }

    // Apply user overrides — overwrite plan field values.
    // Greenhouse fields are keyed by `name`, Ashby fields by `path`.
    const plan = result.plan;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const f of plan.fields as any[]) {
      const key: string | undefined = f.name ?? f.path;
      if (key && overrides[key] !== undefined) {
        f.value = overrides[key];
      }
    }

    // Per-strategy submit
    let submitResult;
    // Browser fills fields then hands off to the user; if we fill fields but can't detect a
    // thank-you page, that's "unconfirmed" (likely fine, detection is heuristic), NOT an error.
    let browserUnconfirmed = false;
    if (plan.strategy === 'greenhouse') {
      submitResult = await submitGreenhouse(plan, { dryRun });
    } else if (plan.strategy === 'ashby') {
      submitResult = await submitAshby(plan, { dryRun });
    } else if (plan.strategy === 'linkedin' || plan.strategy === 'naukri') {
      // LinkedIn / Naukri adapters open the real platform form, autofill what they can, attach the
      // tailored resume, and if autoSubmit is requested, click Submit automatically.
      if (dryRun) {
        submitResult = {
          ok: true,
          status: 0,
          responseBody: {
            dryRun: true,
            url: plan.url,
            wouldFill: plan.fields.map((f) => ({ name: f.name, label: f.label, hasValue: !!f.value })),
          },
          submissionId: undefined,
        };
      } else {
        const p = plan && (plan.strategy === 'linkedin' || plan.strategy === 'naukri') ? plan : null;
        if (!p) {
          return NextResponse.json({ ok: false, error: 'Failed to re-build platform plan' }, { status: 500 });
        }
        // Load profile fresh for the adapter
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profileRow = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as any;
        const profile = profileRow ? JSON.parse(profileRow.parsed_json) : {};
        // Apply user overrides to the fresh plan before handing to the adapter
        for (const f of p.fields as Array<{ name?: string; value?: unknown }>) {
          if (f.name && overrides[f.name] !== undefined) f.value = overrides[f.name];
        }
        const resume = p.attachments.resume;
        if (!resume) {
          return NextResponse.json({ ok: false, error: 'No resume bytes available for the platform adapter' }, { status: 500 });
        }

        const platformResult = p.strategy === 'linkedin'
          ? await linkedInApply({
              jobUrl: p.url,
              profile,
              resumePdfBytes: resume.bytes,
              resumeFilename: resume.filename,
              coverLetterText: p.attachments.coverLetter
                ? new TextDecoder().decode(p.attachments.coverLetter.bytes)
                : undefined,
              autoSubmit,
            })
          : await naukriApply({
              jobUrl: p.url,
              profile,
              resumePdfBytes: resume.bytes,
              resumeFilename: resume.filename,
              companyName: p.company,
              jobTitle: p.jobTitle,
              autoSubmit,
            });

        const stoppedForReview = platformResult.status === 'stopped_for_review';
        const submitted = platformResult.status === 'submitted';
        const loginRequired = platformResult.status === 'login_required';
        const captcha = platformResult.status === 'captcha';
        const ok = submitted || stoppedForReview;
        submitResult = {
          ok,
          status: ok ? 200 : 0,
          // `stopped_for_review` is returned in the response so the UI shows "review & submit
          // manually" instead of "submitted" — nothing was actually submitted.
          responseBody: {
            platform: plan.strategy,
            platformStatus: platformResult.status,
            filledFields: platformResult.filledFields,
            resumeAttached: platformResult.resumeAttached,
            stepCount: platformResult.stepCount,
            submitted,
            stoppedForReview,
            readyForSubmit: platformResult.readyForSubmit ?? false,
            loginRequired,
            captcha,
          },
          submissionId: undefined,
          error: ok
            ? undefined
            : loginRequired
              ? 'Naukri login required. Please log into your Naukri account in the Chrome window.'
              : captcha
                ? 'CAPTCHA detected. Please solve it in the Chrome window.'
                : platformResult.error || `Platform flow failed (${platformResult.status})`,
        };

        if (!ok && platformResult.error?.includes('company website')) {
          try {
            db.prepare("UPDATE job_postings SET apply_type = 'external' WHERE id = ?").run(jobId);
          } catch {}
        }
      }
    } else if (plan.strategy === 'browser') {
      if (dryRun) {
        // Dry-run for browser: log what we WOULD fill, don't actually open browser
        submitResult = {
          ok: true,
          status: 0,
          responseBody: {
            dryRun: true,
            url: plan.url,
            wouldFill: plan.fields.map((f) => ({ name: f.name, label: f.label, hasValue: !!f.value })),
          },
          submissionId: undefined,
        };
      } else {
        const bp = plan && plan.strategy === 'browser' ? (plan as BrowserSubmissionPlan) : null;
        if (!bp) {
          return NextResponse.json({ ok: false, error: 'Failed to re-build browser plan' }, { status: 500 });
        }
        // Load profile fresh for autofill
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profileRow = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as any;
        const profile = profileRow ? JSON.parse(profileRow.parsed_json) : {};
        const autofillResult = await browserAutofill({
          url: bp.url,
          profile,
          questions: bp.fields.map((f) => ({
            name: f.name,
            label: f.label,
            value: f.value,
          })),
          jobTitle: bp.jobTitle,
          company: bp.company,
          resumePdfBuf: bp.attachments.resume?.bytes,
          resumeFilename: bp.attachments.resume?.filename,
          coverLetterText: bp.attachments.coverLetter
            ? new TextDecoder().decode(bp.attachments.coverLetter.bytes)
            : undefined,
          // Return once the form is FILLED. Waiting for the user to press Submit took up to eight
          // minutes and used to happen inside this request handler, holding the connection (and a
          // Next.js route worker) open the whole time. The window stays open and the watch keeps
          // running — `onSettled` records the real outcome whenever it lands.
          detachWait: true,
          onSettled: ({ detected, finalUrl, durationMs }) => {
            try {
              // Only the RESOLVED outcome is worth a second audit row. The response path already
              // logged `submitted_unconfirmed` for this attempt, so writing that status again on a
              // watch timeout just double-counts the same event in the log you read when an
              // application goes missing. A detected submission is genuinely new information.
              if (detected) {
                db.prepare(
                  `INSERT INTO apply_audit (job_id, strategy, status, error, payload_snapshot)
                   VALUES (?, 'browser', 'success', NULL, ?)`,
                ).run(jobId, JSON.stringify({ finalUrl, durationMs, detected }));
              }
              if (detected) {
                // Upgrade the provisional record written below into a confirmed one.
                db.prepare(
                  `UPDATE my_applications SET submission_error = NULL, last_status_change_at = ?
                   WHERE job_id = ?`,
                ).run(new Date().toISOString(), jobId);
              }
            } catch (e) {
              console.warn('[apply] could not record background submission result:', (e as Error).message);
            }
          },
        });
        const filledCount = autofillResult.filledFields?.length ?? 0;
        // With `detachWait` the answer is never "detected" yet — the user hasn't pressed Submit at
        // the moment this responds. Filled fields therefore mean "in progress / unconfirmed", which
        // is exactly the three-state the UI now renders, and `onSettled` upgrades it later.
        browserUnconfirmed = !autofillResult.detectedSubmission && !autofillResult.error && filledCount > 0;
        submitResult = {
          ok: autofillResult.detectedSubmission,
          status: autofillResult.ok ? 200 : 0,
          responseBody: {
            filledFields: autofillResult.filledFields,
            attachedFiles: autofillResult.attachedFiles,
            finalUrl: autofillResult.finalUrl,
            durationMs: autofillResult.durationMs,
            detectedSubmission: autofillResult.detectedSubmission,
            unconfirmed: browserUnconfirmed,
          },
          submissionId: undefined,
          error: autofillResult.error
            || (autofillResult.detectedSubmission
              ? undefined
              : browserUnconfirmed
                ? undefined // fields filled; user likely submitted — just couldn't auto-detect the thank-you page
                // Zero fields filled almost never means "you closed the window" — it means the page
                // we opened has no application form on it. Many job URLs are DESCRIPTION pages on
                // aggregators that hand off elsewhere to apply. Saying so is far more useful than
                // blaming the user, and it matches what they see: a browser window with nothing
                // filled in.
                : 'No application form was found on that page — it looks like a job description rather than an apply form. Use "Apply on company site" and submit there; the window stays open so you can continue.'),
        };
      }
    } else {
      // Unreachable: `prepareSubmission` rejects `manual` before a plan is ever built, and the only
      // remaining strategies are the three handled above. Kept as an explicit guard so adding a
      // strategy without a submitter fails loudly here instead of silently doing nothing.
      return NextResponse.json(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ok: false, error: `No submitter for strategy '${(plan as any).strategy}'` },
        { status: 500 },
      );
    }

    // Audit log
    // For LinkedIn/Naukri the adapter STOPS before the final Submit — nothing was actually sent, so
    // the audit records `stopped_for_review` rather than `success`, and the job is NOT marked
    // applied in the tracker (the user reviews and submits manually; they confirm it in /tracker).
    const stoppedForReview =
      (plan.strategy === 'linkedin' || plan.strategy === 'naukri') &&
      !dryRun &&
      (submitResult.responseBody as { stoppedForReview?: boolean })?.stoppedForReview === true;
    const auditStatus = dryRun
      ? 'dry_run'
      : stoppedForReview
        ? 'stopped_for_review'
        : submitResult.ok
          ? 'success'
          : browserUnconfirmed
            ? 'submitted_unconfirmed'
            : 'error';
    db.prepare(
      `INSERT INTO apply_audit (job_id, strategy, status, error, submission_id, payload_snapshot)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      plan.strategy,
      auditStatus,
      submitResult.ok ? null : submitResult.error || `HTTP ${submitResult.status}`,
      submitResult.submissionId || null,
      JSON.stringify({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fields: (plan.fields as any[]).map((f) => ({ name: f.name ?? f.path, type: f.type, value: f.value, source: f.source })),
        response: submitResult.responseBody,
      }).slice(0, 50_000), // cap payload size
    );

    // Track the application on success — and ALSO when a browser autofill ran but we couldn't
    // detect the thank-you page.
    //
    // That "unconfirmed" case used to be dropped on the floor: the API returned `unconfirmed: true`
    // but this block required `submitResult.ok`, so the most likely real outcome of the browser
    // flow (fields filled, user clicked Submit, no thank-you page matched our heuristics) was never
    // written to `my_applications` at all. The user saw "Submission failed" and the job stayed out
    // of the tracker.
    //
    // `status` has a CHECK constraint limited to the five tracker columns, so the uncertainty is
    // recorded in `submission_error` instead of inventing a sixth status — it surfaces in the
    // tracker as a note to confirm, rather than silently claiming a confirmed submission.
    //
    // LinkedIn/Naukri `stopped_for_review` flows are deliberately NOT tracked here — nothing was
    // submitted, so the job stays in the match list until the user submits manually and confirms.
    const UNCONFIRMED_NOTE =
      'Autofill completed but the confirmation page was not detected — check your email and confirm this one was actually submitted.';
    const alreadyAppliedOnPlatform =
      (submitResult.responseBody as { platformStatus?: string })?.platformStatus === 'already_applied' ||
      submitResult.error?.toLowerCase().includes('already applied') ||
      false;
    const isPlatformSubmitted = (submitResult.responseBody as { submitted?: boolean })?.submitted === true;
    const shouldTrack = !dryRun && (
      submitResult.ok ||
      isPlatformSubmitted ||
      browserUnconfirmed ||
      alreadyAppliedOnPlatform ||
      (autoSubmit && (stoppedForReview || (submitResult.responseBody as { readyForSubmit?: boolean })?.readyForSubmit))
    );
    if (shouldTrack) {
      const exists = db.prepare('SELECT id FROM my_applications WHERE job_id = ?').get(jobId);
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const note = (submitResult.ok && !stoppedForReview)
        ? null
        : alreadyAppliedOnPlatform
          ? `Already applied on ${plan.strategy}`
          : (autoSubmit && stoppedForReview)
            ? 'Pre-filled in Chrome during Auto-Apply — confirm final submit in Tracker'
            : UNCONFIRMED_NOTE;
      if (exists) {
        db.prepare(
          `UPDATE my_applications
           SET status = 'applied',
               submitted_via = ?,
               submitted_at = ?,
               applied_at = ?,
               applied_date = ?,
               submission_id = ?,
               submission_error = ?,
               last_status_change_at = ?
           WHERE job_id = ?`
        ).run(plan.strategy, now, now, today, submitResult.submissionId || null, note, now, jobId);
      } else {
        db.prepare(
          `INSERT INTO my_applications
            (job_id, status, submitted_via, submitted_at, applied_at, applied_date, submission_id, submission_error, last_status_change_at)
           VALUES (?, 'applied', ?, ?, ?, ?, ?, ?, ?)`
        ).run(jobId, plan.strategy, now, now, today, submitResult.submissionId || null, note, now);
      }
      // A real application now exists, so any speculatively-cached cover letter / resume variant
      // belongs ON it — the tracker should show what was actually sent.
      promoteDocumentsToApplication(jobId);

      // Invalidate match cache so dashboard immediately removes the applied job
      try {
        const { invalidateMatchCache } = await import('@/lib/matches');
        invalidateMatchCache(jobId, { applied: true, applicationStatus: 'applied' });
      } catch (e) {
        console.warn('[apply] match cache invalidation error:', e);
      }

      // Automatically calculate and store tailored match score for the applied job
      try {
        const { calculateAndStoreTailoredScore } = await import('@/lib/tailored-score');
        await calculateAndStoreTailoredScore(jobId);
      } catch (e) {
        console.warn('[apply] auto tailored score error:', e);
      }
    }

    return NextResponse.json({
      ok: submitResult.ok || isPlatformSubmitted || alreadyAppliedOnPlatform || (autoSubmit && shouldTrack),
      unconfirmed: browserUnconfirmed,
      stoppedForReview: stoppedForReview && !autoSubmit,
      alreadyApplied: alreadyAppliedOnPlatform,
      readyForSubmit: (submitResult.responseBody as { readyForSubmit?: boolean })?.readyForSubmit ?? false,
      dryRun,
      strategy: plan.strategy,
      submissionId: submitResult.submissionId,
      status: submitResult.status,
      response: submitResult.responseBody,
      error: submitResult.error,
    });
  } catch (error) {
    console.error('Apply submit error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}
