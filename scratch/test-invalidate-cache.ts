import db from '@/lib/db';
import { getRankedMatches, RankedMatch } from '@/lib/matches';
import { buildMatchesPage } from '@/lib/matches-page';

async function testCacheUpdate() {
  console.log('=== TESTING PRECISE MATCH CACHE MUTATION ===');

  // Load matches
  const page0 = buildMatchesPage({ limit: 5 });
  const testJob = page0.matches[0];
  console.log(`Initial top job: [${testJob.id}] "${testJob.title}"`);

  // Hide it in DB
  db.prepare('UPDATE job_postings SET hidden_at = CURRENT_TIMESTAMP WHERE id = ?').run(testJob.id);

  // Now mutate match_cache in-memory / SQLite
  // Read row from match_cache
  const rows = db.prepare('SELECT cache_key, signature, payload FROM match_cache').all() as any[];
  for (const row of rows) {
    const data = JSON.parse(row.payload);
    // Remove testJob from ranked
    data.ranked = data.ranked.filter((m: any) => m.id !== testJob.id);
    data.hiddenCount = (data.hiddenCount || 0) + 1;
    // We compute new signature
    const o = {
      includeHidden: row.cache_key[0] === 'h',
      includeExpired: row.cache_key[1] === 'e',
      includeApplied: row.cache_key[2] === 'a',
    };
    // Update DB
    db.prepare('UPDATE match_cache SET payload = ? WHERE cache_key = ?').run(JSON.stringify(data), row.cache_key);
  }

  // Clear memo so it re-reads updated payload
  const globalForMatchMemo = globalThis as any;
  if (globalForMatchMemo.__hsMatchMemo) {
    globalForMatchMemo.__hsMatchMemo.clear();
  }

  // Now buildMatchesPage again
  const page1 = buildMatchesPage({ limit: 5 });
  const stillThere = page1.matches.some(m => m.id === testJob.id);
  console.log(`After precise mutation, is hidden job [${testJob.id}] still in feed? -> ${stillThere}`);

  // Restore
  db.prepare('UPDATE job_postings SET hidden_at = NULL WHERE id = ?').run(testJob.id);
  db.prepare('DELETE FROM match_cache').run();
  if (globalForMatchMemo.__hsMatchMemo) globalForMatchMemo.__hsMatchMemo.clear();
  console.log('Cleaned up.');
}

testCacheUpdate().catch(console.error);
