// evaluate-top.ts — run the LLM evaluation on the top-N matches so ratings are complete
// without the user clicking "Evaluate top 30" in the UI. Part of `npm run daily`.
//
// Evaluates the top MATCH_LIMIT ACTIVE, embedded matches (by cosine to the resume) that don't
// yet have a job_evaluations row. Uses the app's canonical db handle + evaluateJob (so it
// respects the /settings provider config). Sequential + polite to stay within free-tier limits.
//
// Run: npx ts-node scripts/evaluate-top.ts

import './shared/env';
import db from '../src/lib/db';
import { evaluateJob, getActiveProviderName } from '../src/lib/llm';
import { getRankedMatches } from '../src/lib/matches';

const MATCH_LIMIT = Math.min(Math.max(parseInt(process.env.MATCH_LIMIT || '30', 10) || 30, 1), 200);

interface Row {
  id: number;
  title: string;
  company: string;
  location: string;
  description: string;
}

const upsert = db.prepare(
  `INSERT INTO job_evaluations (job_id, provider, overall_score, recommendation,
     cv_alignment_score, cv_alignment_notes, north_star_fit_score, north_star_fit_notes,
     compensation_score, compensation_notes, culture_score, culture_notes, strategy_notes)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(job_id) DO UPDATE SET
     provider = excluded.provider, computed_at = CURRENT_TIMESTAMP,
     overall_score = excluded.overall_score, recommendation = excluded.recommendation,
     cv_alignment_score = excluded.cv_alignment_score, cv_alignment_notes = excluded.cv_alignment_notes,
     north_star_fit_score = excluded.north_star_fit_score, north_star_fit_notes = excluded.north_star_fit_notes,
     compensation_score = excluded.compensation_score, compensation_notes = excluded.compensation_notes,
     culture_score = excluded.culture_score, culture_notes = excluded.culture_notes,
     strategy_notes = excluded.strategy_notes`
);

async function main() {
  const profile = db.prepare('SELECT parsed_json, embedding FROM my_profile WHERE id = 1').get() as
    | { parsed_json: string; embedding: Buffer }
    | undefined;
  if (!profile?.embedding) {
    console.log('evaluate-top: no resume/profile — upload one first. Skipping.');
    db.close();
    return;
  }
  const resumeJson = JSON.parse(profile.parsed_json);

  // Top-N unevaluated matches, ranked BY THE SAME ENGINE THE DASHBOARD USES.
  //
  // This used to be `ORDER BY vec_distance_cosine(...)` — pure embedding similarity, with no BM25
  // leg, no skill-fit check and none of the composite's context terms. So the jobs we spent LLM
  // quota rating were not the jobs the user actually sees at the top of their list: the ranking
  // this script used was the one that scored a Java architect role 98% for a candidate who has
  // never written Java. Reading `getRankedMatches` means the spend follows the real ranking, and
  // it is a cache read (the dashboard has almost always warmed it already), not a recompute.
  const ranked = getRankedMatches({ includeHidden: false, includeExpired: false });
  let jobs: Row[] = [];

  if (ranked?.ranked?.length) {
    const byId = db.prepare(
      `SELECT id, title, company, location, description FROM job_postings WHERE id = ?`,
    );
    const hasEval = db.prepare('SELECT 1 FROM job_evaluations WHERE job_id = ? LIMIT 1');
    for (const m of ranked.ranked) {
      if (jobs.length >= MATCH_LIMIT) break;
      if (hasEval.get(m.id)) continue; // already rated
      const row = byId.get(m.id) as Row | undefined;
      if (row) jobs.push(row);
    }
    console.log(`evaluate-top: picked from the ranked list (${ranked.ranked.length} ranked)`);
  } else {
    // No cached ranking yet (fresh DB, or before the first dashboard load). Fall back to embedding
    // similarity so the daily pipeline still makes progress rather than rating nothing.
    console.log('evaluate-top: no ranked cache — falling back to embedding similarity');
    jobs = db.prepare(`
      SELECT j.id, j.title, j.company, j.location, j.description
      FROM job_postings j
      LEFT JOIN job_evaluations e ON e.job_id = j.id
      WHERE j.embedding IS NOT NULL AND j.hidden_at IS NULL
        AND j.expired_at IS NULL AND (j.url_status IS NULL OR j.url_status != 'dead')
        AND e.job_id IS NULL
        -- Never spend LLM quota rating a job you have already applied to. Applied jobs live in
        -- /tracker and are excluded from the match list, so an evaluation for one is pure waste.
        AND NOT EXISTS (SELECT 1 FROM my_applications a WHERE a.job_id = j.id)
      ORDER BY vec_distance_cosine(j.embedding, ?) ASC
      LIMIT ?
    `).all(profile.embedding, MATCH_LIMIT) as Row[];
  }

  // Gemini free tier ≈ 15 requests/min; pace under that (default ~4.5s ⇒ ≤13/min) and retry
  // once on a transient error/429 after a longer backoff. Override via EVAL_DELAY_MS.
  const DELAY = parseInt(process.env.EVAL_DELAY_MS || '4500', 10) || 4500;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  console.log(`evaluate-top: ${jobs.length} unevaluated top matches (limit ${MATCH_LIMIT}, provider ${getActiveProviderName()}, ${DELAY}ms pace)`);
  let ok = 0, fail = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        const ev = await evaluateJob(resumeJson, j.title, j.company, j.location || '', j.description || '');
        // Same boundary guard as /api/jobs/[id]/evaluate: a scoreless or prose-less row looks
        // authoritative in the UI and permanently excludes the job from re-evaluation.
        const hasProse = [ev.cv_alignment_notes, ev.north_star_fit_notes, ev.compensation_notes, ev.culture_notes, ev.strategy_notes]
          .some((n) => (n || '').trim().length > 0);
        if (!Number.isFinite(ev.overall_score) || !hasProse) {
          throw new Error('evaluation had no score or no reasoning — not saved');
        }
        upsert.run(
          j.id, getActiveProviderName(), ev.overall_score, ev.recommendation,
          ev.cv_alignment_score, ev.cv_alignment_notes, ev.north_star_fit_score, ev.north_star_fit_notes,
          ev.compensation_score, ev.compensation_notes, ev.culture_score, ev.culture_notes, ev.strategy_notes,
        );
        ok++; saved = true;
        console.log(`  ✓ [${i + 1}/${jobs.length}] ${ev.recommendation.toUpperCase()} ${ev.overall_score} — ${j.title} @ ${j.company}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === 0 && /429|quota|rate|fetching|RESOURCE_EXHAUSTED|Too Many/i.test(msg)) {
          console.log(`  … [${i + 1}/${jobs.length}] rate-limited, backing off 20s`);
          await sleep(20000);
        } else {
          fail++;
          console.log(`  ✗ [${i + 1}/${jobs.length}] ${j.title} @ ${j.company}: ${msg.slice(0, 100)}`);
        }
      }
    }
    await sleep(DELAY);
  }
  console.log(`evaluate-top done: ${ok} evaluated, ${fail} failed.`);
  db.close();
}

main();
