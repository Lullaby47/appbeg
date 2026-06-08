import { NextResponse } from 'next/server';

import { invalidateAppSessionAuthCache } from '@/lib/firebase/apiAuth';
import { revokeAppSession } from '@/lib/sql/appSessions';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const dynamic = 'force-dynamic';

type LogoutBody = {
  sessionId?: unknown;
  reason?: unknown;
};

export async function POST(request: Request) {
  let body: LogoutBody = {};
  try {
    body = (await request.json()) as LogoutBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const sessionId = cleanText(body.sessionId);
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'sessionId is required.' }, { status: 400 });
  }

  const reason = cleanText(body.reason) || 'logout';
  const revoked = await revokeAppSession(sessionId, reason);
  invalidateAppSessionAuthCache(sessionId);

  console.info('[SQL_AUTH_BOOTSTRAP] logout', {
    sessionId,
    revoked,
    reason,
  });

  return NextResponse.json({ ok: true, revoked });
}
