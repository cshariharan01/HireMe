import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { checkPlatformAuthStatus, BROWSER_PROFILE_DIR } from '@/lib/apply/auth-session';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const cookiePath = path.join(BROWSER_PROFILE_DIR, 'Default', 'Network', 'Cookies');
  const { linkedin, naukri } = await checkPlatformAuthStatus(BROWSER_PROFILE_DIR);

  return NextResponse.json({
    connected: {
      linkedin,
      naukri,
    },
    cookieFileExists: fs.existsSync(cookiePath),
  });
}
