import { redirect } from 'next/navigation';
import DashboardClient from './dashboard-client';
import { buildMatchesPage } from '@/lib/matches-page';
import { matchesFallbackKey } from '@/lib/match-keys';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

function isProfileConfigured(): boolean {
  try {
    const db = getDb();
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as
      | { parsed_json: string | null }
      | undefined;
    if (!row || !row.parsed_json) return false;
    const parsed = JSON.parse(row.parsed_json);
    // Consider configured if name or skills are present
    return !!(parsed?.name || (Array.isArray(parsed?.skills) && parsed.skills.length > 0));
  } catch {
    return false;
  }
}

/**
 * Dashboard route — a SERVER component that hands the client a first page of matches.
 *
 * On first launch (no profile), redirects to /setup wizard.
 */
export default function DashboardPage() {
  // First-run check — redirect new users to the setup wizard
  if (!isProfileConfigured()) {
    redirect('/setup');
  }

  let fallback: Record<string, unknown> | undefined;
  try {
    const page = buildMatchesPage();
    if (!('error' in page)) {
      fallback = { [matchesFallbackKey()]: page };
    }
  } catch (e) {
    console.error('[first-paint] could not seed the match list:', e);
  }

  return <DashboardClient fallback={fallback} />;
}
