import { NextResponse } from 'next/server';

import { requirePlayerApiUser } from '@/lib/firebase/apiAuth';
import { logPlayerApiAuthOk } from '@/lib/server/playerApiAuthLog';
import { readCompletedUsernameCarersByPlayer } from '@/lib/sql/completedUsernameCarersRead';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import { recordRouteMetric } from '@/lib/server/logMetrics';
import { API_ROUTE_SLOW_MS, isPlayerVerboseLogs } from '@/lib/server/verboseLogs';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/completed-username-carers';

export async function GET(request: Request) {
  const startedAt = Date.now();
  const headerSessions = sessionIdsFromRequest(request);
  const auth = await requirePlayerApiUser(request);
  if ('response' in auth) {
    logRouteSessionValidation(ROUTE, {
      ok: false,
      ...headerSessions,
      canonical_session_id: headerSessions.player_session_id,
      validates: 'player_session_sql',
      auth_path: auth.timing.auth_path,
      session_source: auth.timing.session_source,
    });
    return auth.response;
  }

  logRouteSessionValidation(ROUTE, {
    ok: true,
    ...headerSessions,
    canonical_session_id: headerSessions.player_session_id,
    validates: 'player_session_sql',
    auth_path: auth.authPath,
    session_source: auth.timing.session_source,
    uid: auth.user.uid,
  });
  logPlayerApiAuthOk(request, {
    route: ROUTE,
    uid: auth.user.uid,
    role: auth.user.role,
    authPath: auth.authPath,
  });

  const mapping = (await readCompletedUsernameCarersByPlayer(auth.user.uid)) ?? {};
  const durationMs = Date.now() - startedAt;
  recordRouteMetric({
    route: ROUTE,
    durationMs,
    ok: true,
    slowThresholdMs: API_ROUTE_SLOW_MS,
  });
  if (isPlayerVerboseLogs() || durationMs >= API_ROUTE_SLOW_MS) {
    console.info('[COMPLETED_USERNAME_CARERS_API]', {
      uid: auth.user.uid,
      gameCount: Object.keys(mapping).length,
      durationMs,
    });
  }

  return NextResponse.json({ mapping, source: 'postgres' });
}
