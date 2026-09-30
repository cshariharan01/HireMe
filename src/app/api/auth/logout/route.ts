import { NextRequest, NextResponse } from 'next/server';
import { clearPlatformSession } from '@/lib/apply/auth-session';

export async function POST(req: NextRequest) {
  let platform: 'naukri' | 'linkedin' | 'all' = 'all';
  try {
    const body = await req.json();
    if (body?.platform && ['naukri', 'linkedin', 'all'].includes(body.platform)) {
      platform = body.platform;
    }
  } catch {
    /* default all */
  }

  const result = await clearPlatformSession(platform);

  return NextResponse.json({
    ok: result.ok,
    platform,
    removedCookies: result.removedCookies,
    message: result.message,
  });
}
