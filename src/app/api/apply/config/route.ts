import { NextRequest, NextResponse } from 'next/server';
import { getApplyConfig, saveApplyConfig, type ApplyConfig } from '@/lib/apply/questions';

export async function GET() {
  try {
    return NextResponse.json({ config: getApplyConfig() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<ApplyConfig>;
    const current = getApplyConfig();
    const next: ApplyConfig = {
      defaults: { ...current.defaults, ...(body.defaults || {}) },
      portals: { ...current.portals, ...(body.portals || {}) },
      rateLimit: { ...current.rateLimit, ...(body.rateLimit || {}) },
      dryRun: body.dryRun ?? current.dryRun,
      resumeSource: body.resumeSource ?? current.resumeSource,
    };
    saveApplyConfig(next);
    return NextResponse.json({ config: next });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed' }, { status: 500 });
  }
}
