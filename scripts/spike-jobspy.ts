// spike-jobspy.ts — timeboxed evaluation of `ts-jobspy` as an ingest source. READ-ONLY: this
// writes NOTHING to the database. It answers the go/no-go questions before any integration:
//
//   1. Does each site actually return results right now? (Scrapers rot; this one last published
//      2026-01. The package's own docs say only linkedin + indeed are operational.)
//   2. Does `hoursOld` work? That is the direct fix for "it fetches the oldest jobs too" — no
//      existing ingest script has ANY date filter.
//   3. Is `datePosted` populated? 41% of our active rows have posted_at = NULL, which is why the
//      new posting-age prune rule can't see them.
//   4. Are the descriptions substantial enough to embed and skill-match against?
//   5. Does it surface India-relevant roles for the profile's actual target roles?
//
// Run: npx ts-node scripts/spike-jobspy.ts
//   SPIKE_SITES=indeed,linkedin   which sites to try (default indeed,linkedin)
//   SPIKE_HOURS=168               hoursOld window (default 168 = 7 days)
//   SPIKE_WANTED=15               resultsWanted per site

import './shared/env';
import db from '../src/lib/db';
import { scrapeJobs } from 'ts-jobspy';
import { getEnabledRoles } from './shared/profile-roles';

const SITES = (process.env.SPIKE_SITES || 'indeed,linkedin').split(',').map((s) => s.trim()).filter(Boolean);
const HOURS = parseInt(process.env.SPIKE_HOURS || '168', 10) || 168;
const WANTED = parseInt(process.env.SPIKE_WANTED || '15', 10) || 15;

function pct(n: number, total: number): string {
  return total === 0 ? 'n/a' : `${Math.round((n / total) * 100)}%`;
}

async function trySite(site: string, searchTerm: string, location: string) {
  const started = Date.now();
  try {
    const jobs = await scrapeJobs({
      siteName: site as never,
      searchTerm,
      location,
      resultsWanted: WANTED,
      hoursOld: HOURS,
      countryIndeed: 'india',
      linkedinFetchDescription: true,
      verbose: 0,
    });
    const ms = Date.now() - started;
    const withDate = jobs.filter((j) => !!j.datePosted).length;
    const withDesc = jobs.filter((j) => (j.description || '').length > 400).length;
    const withSalary = jobs.filter((j) => j.minAmount != null || j.maxAmount != null).length;
    const inIndia = jobs.filter((j) => /india|bengaluru|bangalore|pune|hyderabad|mumbai|delhi|noida|gurgaon|chennai|remote/i.test(j.location || '')).length;

    console.log(`  ${jobs.length > 0 ? 'OK  ' : 'NONE'} ${site.padEnd(9)} "${searchTerm}" @ ${location} -> ${jobs.length} jobs in ${(ms / 1000).toFixed(1)}s`);
    if (jobs.length) {
      console.log(`         datePosted present: ${withDate}/${jobs.length} (${pct(withDate, jobs.length)})   <-- fixes our 41% NULL posted_at`);
      console.log(`         description >400ch: ${withDesc}/${jobs.length} (${pct(withDesc, jobs.length)})`);
      console.log(`         salary present:     ${withSalary}/${jobs.length} (${pct(withSalary, jobs.length)})`);
      console.log(`         India/remote:       ${inIndia}/${jobs.length} (${pct(inIndia, jobs.length)})`);
      const oldest = jobs.map((j) => j.datePosted).filter(Boolean).sort()[0];
      const newest = jobs.map((j) => j.datePosted).filter(Boolean).sort().pop();
      console.log(`         date range:         ${oldest || '?'} .. ${newest || '?'}  (asked for <= ${HOURS}h old)`);
      for (const j of jobs.slice(0, 3)) {
        console.log(`           - ${String(j.title).slice(0, 52).padEnd(52)} @ ${String(j.company || '?').slice(0, 22).padEnd(22)} ${j.datePosted || 'no date'}`);
      }
    }
    return { site, count: jobs.length, ms, withDate, withDesc, ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  FAIL ${site.padEnd(9)} "${searchTerm}" @ ${location} -> ${msg.slice(0, 120)}`);
    return { site, count: 0, ms: Date.now() - started, withDate: 0, withDesc: 0, ok: false };
  }
}

async function main() {
  const roles = getEnabledRoles(db);
  const searchTerm = roles[0] || 'Solution Architect';
  console.log(`ts-jobspy spike — READ ONLY, nothing is written to the database.`);
  console.log(`  profile target roles: ${roles.length ? roles.slice(0, 5).join(', ') : '(none set, using a default)'}`);
  console.log(`  search term: "${searchTerm}"   hoursOld: ${HOURS}   resultsWanted: ${WANTED}`);
  console.log(`  sites: ${SITES.join(', ')}\n`);

  const results = [];
  for (const site of SITES) {
    results.push(await trySite(site, searchTerm, 'India'));
  }

  console.log('\n--- verdict ---');
  const working = results.filter((r) => r.ok && r.count > 0);
  if (working.length === 0) {
    console.log('  NO-GO: no site returned anything. Keep the existing scrapers.');
  } else {
    for (const r of working) {
      const dateCoverage = r.count ? Math.round((r.withDate / r.count) * 100) : 0;
      console.log(`  ${r.site}: ${r.count} jobs, ${dateCoverage}% with a posting date, ${(r.ms / 1000).toFixed(0)}s`);
    }
    console.log(`  ${working.length} of ${SITES.length} site(s) usable.`);
  }
  const dead = results.filter((r) => !r.ok || r.count === 0);
  if (dead.length) console.log(`  not usable right now: ${dead.map((d) => d.site).join(', ')}`);
}

main().catch((e) => {
  console.error('spike error:', e);
  process.exitCode = 1;
});
