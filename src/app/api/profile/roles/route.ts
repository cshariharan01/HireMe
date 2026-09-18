import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { deriveTargetRoles } from '@/lib/llm';

// POST /api/profile/roles — re-derive resume-fit target roles from the stored profile
// (no PDF re-upload needed). Refreshes `suggested_roles` and resets `targets.roles`
// to all suggested (all-on), preserving the other non-role target fields.
export async function POST() {
  try {
    const row = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as { parsed_json: string } | undefined;
    if (!row) return NextResponse.json({ error: 'No profile — upload a resume first' }, { status: 404 });

    const parsed = JSON.parse(row.parsed_json);
    const suggestedRoles = await deriveTargetRoles(parsed);
    const merged = {
      ...parsed,
      suggested_roles: suggestedRoles,
      targets: { ...(parsed.targets ?? {}), roles: suggestedRoles },
    };
    db.prepare('UPDATE my_profile SET parsed_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(JSON.stringify(merged));

    return NextResponse.json({ success: true, suggestedRoles, profile: merged });
  } catch (error) {
    console.error('Regenerate roles error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to derive roles' },
      { status: 500 }
    );
  }
}
