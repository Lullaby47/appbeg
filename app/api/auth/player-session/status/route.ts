import { NextResponse } from 'next/server';

import { resolvePlayerSessionStatus } from '@/lib/server/playerSessionStatus';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headerSessions = sessionIdsFromRequest(request);
  const { status, result } = await resolvePlayerSessionStatus(request);
  logRouteSessionValidation('/api/auth/player-session/status', {
    ok: result.ok === true,
    status: status,
    ...headerSessions,
    canonical_session_id: headerSessions.player_session_id,
    validates: 'player_session_sql',
    reason: result.ok ? 'session_match' : result.reason || 'unknown',
    source: result.source || null,
  });
  return NextResponse.json(result, { status });
}
