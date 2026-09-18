import { NextResponse } from 'next/server';
import db from '@/lib/db';

// GET /api/resumes — list the resume library (metadata only, no blobs).
export async function GET() {
  try {
    const rows = db.prepare(
      `SELECT id, label, is_active, created_at, updated_at,
              (embedding IS NOT NULL) AS has_embedding, parsed_json
       FROM resumes ORDER BY is_active DESC, updated_at DESC`
    ).all() as Array<{ id: number; label: string; is_active: number; created_at: string; updated_at: string; has_embedding: number; parsed_json: string | null }>;

    const resumes = rows.map((r) => {
      let name: string | undefined;
      let title: string | undefined;
      let skillCount = 0;
      let roleCount = 0;
      try {
        const p = r.parsed_json ? JSON.parse(r.parsed_json) : {};
        name = p.name; title = p.title;
        skillCount = Array.isArray(p.skills) ? p.skills.length : 0;
        roleCount = Array.isArray(p.targets?.roles) ? p.targets.roles.length : 0;
      } catch { /* ignore malformed */ }
      return {
        id: r.id,
        label: r.label,
        isActive: !!r.is_active,
        hasEmbedding: !!r.has_embedding,
        updatedAt: r.updated_at,
        name, title, skillCount, roleCount,
      };
    });
    return NextResponse.json({ resumes });
  } catch (error) {
    console.error('List resumes error:', error);
    return NextResponse.json({ error: 'Failed to list resumes' }, { status: 500 });
  }
}
