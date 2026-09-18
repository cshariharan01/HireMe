// test-apply.ts — dry-run smoke test for the auto-apply pipeline (Greenhouse + Ashby).
//
// Builds a submission plan (no real submit) for one live Greenhouse job and one live Ashby
// job from the DB, and asserts: plan builds, fields are answered, a tailored resume PDF
// renders. Run this before trusting a real submission.
//
// Run: npx ts-node scripts/test-apply.ts

import db from '../src/lib/db';
import { prepareSubmission } from '../src/lib/apply/prepare';

interface JobRow { id: number; company: string; title: string; url: string; }

function pick(source: string): JobRow | undefined {
  return db.prepare(
    `SELECT id, company, title, url FROM job_postings
     WHERE source = ? AND url IS NOT NULL AND url != ''
       AND (expired_at IS NULL) AND (url_status IS NULL OR url_status != 'dead')
     ORDER BY ingested_at DESC LIMIT 1`
  ).get(source) as JobRow | undefined;
}

async function testOne(label: string, job: JobRow | undefined) {
  if (!job) { console.log(`\n[${label}] no candidate job in DB — skipping`); return; }
  console.log(`\n[${label}] job #${job.id}: ${job.title} @ ${job.company}`);
  console.log(`  url: ${job.url}`);
  try {
    const result = await prepareSubmission(job.id);
    if (!result.ok || !result.plan) {
      console.log(`  ✗ prepare failed: ${result.error}`);
      return;
    }
    const plan = result.plan;
    const fieldCount = (plan as { fields?: unknown[] }).fields?.length ?? 0;
    const hasResume = !!(plan as { attachments?: { resume?: unknown } }).attachments?.resume;
    console.log(`  ✓ strategy=${plan.strategy} | fields=${fieldCount} | resumePDF=${hasResume ? 'rendered' : 'MISSING'} | warnings=${result.warnings.length}`);
    for (const w of result.warnings) console.log(`      ⚠ ${w.code}: ${w.message}`);
    if (!fieldCount) console.log('      ✗ ASSERT FAILED: no fields answered');
    if (!hasResume) console.log('      ✗ ASSERT FAILED: no resume PDF');
  } catch (e) {
    console.log(`  ✗ exception: ${(e as Error).message}`);
  }
}

async function main() {
  console.log('Auto-apply dry-run smoke test (Greenhouse + Ashby)...');
  await testOne('greenhouse', pick('greenhouse'));
  await testOne('ashby', pick('ashby'));
  console.log('\nDone. (No applications were submitted.)');
  db.close();
}

main();
