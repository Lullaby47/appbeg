import { NextResponse } from 'next/server';

import {
  apiError,
  requireApiUser,
  scopedCoadminUid,
  type ApiUser,
  type ApiUserAuthPath,
} from '@/lib/firebase/apiAuth';
import { readCarerBaseDataForCoadmin } from '@/lib/sql/carerBaseDataCache';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

function resolveExplicitCoadminUid(request: Request) {
  const url = new URL(request.url);
  return cleanText(url.searchParams.get('coadminUid'));
}

function canAccessCoadmin(authUser: ApiUser, requested: string, scoped: string | null) {
  if (authUser.role === 'admin') return true;
  if (authUser.role === 'coadmin') return requested === authUser.uid;
  return Boolean(scoped && requested === scoped);
}

function logAppSessionHeaderDebug(request: Request, route: string) {
  const sessionId = cleanText(request.headers.get('X-App-Session-Id'));
  console.info('[APP_SESSION_HEADER_DEBUG]', {
    route,
    hasHeader: Boolean(sessionId),
    sessionIdPrefix: sessionId ? sessionId.slice(0, 8) : null,
    reason: sessionId ? 'header_present' : 'missing_header',
  });
}

function logCarerBaseData(
  authPath: ApiUserAuthPath,
  coadminUid: string,
  payload: Awaited<ReturnType<typeof readCarerBaseDataForCoadmin>>
) {
  console.info('[CARER_BASE_DATA]', {
    source: payload.source,
    auth_path: authPath,
    auth_source: authPath === 'api_user_firestore' ? 'firestore' : 'sql',
    firestore_fallback: authPath === 'api_user_firestore',
    shared_client: payload.timing.shared_client,
    parallel: payload.timing.parallel,
    client_acquire_ms: payload.timing.client_acquire_ms,
    players_ms: payload.timing.players_ms,
    game_logins_ms: payload.timing.game_logins_ms,
    player_game_logins_ms: payload.timing.player_game_logins_ms,
    total_sql_ms: payload.timing.total_sql_ms,
    pool_waiting_max: payload.timing.pool_waiting_max,
    total_ms: payload.timing.total_ms,
    counts: {
      players: payload.players.length,
      gameLogins: payload.gameLogins.length,
      playerGameLogins: payload.playerGameLogins.length,
    },
    coadminUid,
    snapshotAt: payload.snapshotAt,
  });
}

export async function GET(request: Request) {
  logAppSessionHeaderDebug(request, '/api/carer/base-data');

  const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
  if ('response' in auth) {
    return auth.response;
  }

  const scoped = scopedCoadminUid(auth.user);
  const coadminUid = resolveExplicitCoadminUid(request) || scoped;
  if (!coadminUid) {
    return NextResponse.json({
      players: [],
      gameLogins: [],
      playerGameLogins: [],
      source: 'fallback',
      snapshotAt: new Date().toISOString(),
    });
  }

  if (!canAccessCoadmin(auth.user, coadminUid, scoped)) {
    return apiError('Forbidden.', 403);
  }

  const payload = await readCarerBaseDataForCoadmin(coadminUid);
  logCarerBaseData(auth.authPath, coadminUid, payload);
  if (auth.timing) {
    console.info('[CARER_BASE_DATA_AUTH]', {
      auth_path: auth.authPath,
      source: auth.authPath === 'api_user_firestore' ? 'firestore' : 'sql',
      firestore_fallback: auth.authPath === 'api_user_firestore',
      sql_profile_ms: auth.timing.sql_profile_ms,
      user_doc_ms: auth.timing.user_doc_ms,
      auth_ms: auth.timing.auth_ms,
    });
  }

  return NextResponse.json({
    players: payload.players,
    gameLogins: payload.gameLogins,
    playerGameLogins: payload.playerGameLogins,
    source: payload.source,
    snapshotAt: payload.snapshotAt,
  });
}
