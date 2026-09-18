import { NextResponse } from 'next/server';
import { setActiveResume } from '@/lib/resumes';

// POST /api/resumes/[id]/activate — make this resume the active one (mirrors into my_profile).
// After switching, matches recompute against the newly-active resume's embedding.
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const id = parseInt(params.id, 10);
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const ok = setActiveResume(id);
    if (!ok) return NextResponse.json({ error: 'Resume not found' }, { status: 404 });
    return NextResponse.json({ success: true, activeId: id });
  } catch (error) {
    console.error('Activate resume error:', error);
    return NextResponse.json({ error: 'Failed to activate resume' }, { status: 500 });
  }
}
