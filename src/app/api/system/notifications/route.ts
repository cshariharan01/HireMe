import { NextRequest, NextResponse } from 'next/server';
import { getUnreadSystemNotifications, markSystemNotificationsRead } from '@/lib/db';
import { ensureWorkingGeminiModel } from '@/lib/llm';

// GET /api/system/notifications — returns all unread notifications
export async function GET() {
  try {
    const notifications = getUnreadSystemNotifications();
    return NextResponse.json({ ok: true, notifications });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

// POST /api/system/notifications — mark read or test-switch
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.action === 'test_and_switch') {
      const result = await ensureWorkingGeminiModel(true);
      return NextResponse.json({ ok: true, ...result });
    }

    const ids = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    if (ids.length > 0) {
      markSystemNotificationsRead(ids);
    }
    return NextResponse.json({ ok: true, marked: ids.length });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
