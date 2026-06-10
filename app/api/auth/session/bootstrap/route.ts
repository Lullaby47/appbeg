import { NextResponse } from 'next/server';

import { apiError } from '@/lib/firebase/apiAuth';
import { verifyLiveCarerApiToken } from '@/lib/firebase/liveAuthTokenCache';
import { isPlayerSessionSqlReadEnabled } from '@/lib/server/authSqlRead';
import { createPlayerLoginSessionsInSql } from '@/lib/server/sqlPlayerLoginSessions';
import { logSqlLoginNoFirestoreMirror } from '@/lib/server/sqlSessionNoFirestoreMirror';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import { createAppSessionForUser } from '@/lib/sql/appSessions';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const dynamic = 'force-dynamic';

type BootstrapBody = {
  deviceId?: unknown;
  playerSessionId?: unknown;
  roleHint?: unknown;
};

function bearerToken(request: Request) {
  return (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1] || '';
}

function isLoginAllowedStatus(status: string | null, role: string) {
  const normalizedStatus = cleanText(status).toLowerCase();
  const normalizedRole = cleanText(role).toLowerCase();
  const isActive = normalizedStatus === 'active';
  const isBlockedPlayer = normalizedStatus === 'disabled' && normalizedRole === 'player';
  return isActive || isBlockedPlayer;
}

export async function POST(request: Request) {
  const totalStartedAt = Date.now();
  const headerSessions = sessionIdsFromRequest(request);
  const token = bearerToken(request);
  if (!token) {
    return apiError('Missing or invalid authorization.', 401);
  }

  let body: BootstrapBody = {};
  try {
    body = (await request.json()) as BootstrapBody;
  } catch {
    body = {};
  }

  const verifyStartedAt = Date.now();
  let identityUid = '';
  let tokenCacheHit = false;
  try {
    const verified = await verifyLiveCarerApiToken(token);
    identityUid = verified.uid;
    tokenCacheHit = verified.cacheHit;
  } catch {
    console.info('[SQL_AUTH_BOOTSTRAP]', {
      ok: false,
      reason: 'invalid_token',
      verify_token_ms: Date.now() - verifyStartedAt,
      total_ms: Date.now() - totalStartedAt,
    });
    return apiError('Invalid or expired authorization token.', 401);
  }
  const verifyTokenMs = Date.now() - verifyStartedAt;

  const sqlProfileStartedAt = Date.now();
  const sqlProfileLookup = await lookupApiUserProfileFromSqlCache(identityUid);
  const sqlProfileMs = Date.now() - sqlProfileStartedAt;

  if (!sqlProfileLookup.profile) {
    console.info('[SQL_AUTH_BOOTSTRAP]', {
      ok: false,
      uid: identityUid,
      reason: sqlProfileLookup.missReason || 'profile_missing',
      token_cache_hit: tokenCacheHit,
      verify_token_ms: verifyTokenMs,
      sql_profile_ms: sqlProfileMs,
      total_ms: Date.now() - totalStartedAt,
    });
    return apiError('User profile not found.', 401);
  }

  const profile = sqlProfileLookup.profile;
  const roleHint = cleanText(body.roleHint).toLowerCase();
  if (roleHint && roleHint !== profile.role) {
    console.info('[SQL_AUTH_BOOTSTRAP]', {
      ok: false,
      uid: profile.uid,
      role: profile.role,
      role_hint: roleHint,
      reason: 'role_hint_mismatch',
      token_cache_hit: tokenCacheHit,
      verify_token_ms: verifyTokenMs,
      sql_profile_ms: sqlProfileMs,
      total_ms: Date.now() - totalStartedAt,
    });
    return apiError('Forbidden.', 403);
  }

  if (!isLoginAllowedStatus(profile.status, profile.role)) {
    console.info('[SQL_AUTH_BOOTSTRAP]', {
      ok: false,
      uid: profile.uid,
      role: profile.role,
      status: profile.status,
      reason: 'account_not_active',
      token_cache_hit: tokenCacheHit,
      verify_token_ms: verifyTokenMs,
      sql_profile_ms: sqlProfileMs,
      total_ms: Date.now() - totalStartedAt,
    });
    return apiError('Account is not active.', 403);
  }

  const deviceId = cleanText(body.deviceId) || null;
  const requestedPlayerSessionId =
    cleanText(body.playerSessionId) || headerSessions.player_session_id || null;
  const sessionCreateStartedAt = Date.now();

  try {
    if (profile.role === 'player') {
      if (!deviceId) {
        console.info('[SQL_AUTH_BOOTSTRAP]', {
          ok: false,
          uid: profile.uid,
          role: profile.role,
          reason: 'missing_device_id',
          total_ms: Date.now() - totalStartedAt,
        });
        return apiError('deviceId is required for player bootstrap.', 400);
      }

      const loginSessions = await createPlayerLoginSessionsInSql({
        playerUid: profile.uid,
        deviceId,
        role: profile.role,
        coadminUid: profile.coadminUid,
        username: profile.username,
        playerSessionId: requestedPlayerSessionId || undefined,
        actorSource: 'firebase_login_bootstrap',
        appSessionRawContext: {
          source: 'firebase_login_bootstrap',
          requestedPlayerSessionId,
        },
      });

      const session = loginSessions.appSession;
      const playerSessionId = loginSessions.playerSessionId;
      const sessionCreateMs = Date.now() - sessionCreateStartedAt;

      if (isPlayerSessionSqlReadEnabled()) {
        logSqlLoginNoFirestoreMirror({
          route: '/api/auth/session/bootstrap',
          uid: profile.uid,
          role: profile.role,
          playerSessionIdPrefix: playerSessionId.slice(0, 8),
          appSessionIdPrefix: session.sessionId.slice(0, 8),
        });
      }

      logRouteSessionValidation('/api/auth/session/bootstrap', {
        ok: true,
        uid: profile.uid,
        role: profile.role,
        canonical_session_id: playerSessionId,
        app_session_id: session.sessionId,
        player_session_id: playerSessionId,
        validates: 'player_session_sql',
        resumed: loginSessions.previousSessionIds.length === 0 && Boolean(requestedPlayerSessionId),
        previous_session_count: loginSessions.previousSessionIds.length,
      });

      console.info('[SQL_AUTH_BOOTSTRAP]', {
        ok: true,
        uid: profile.uid,
        role: profile.role,
        sessionId: session.sessionId,
        playerSessionId,
        canonical_session_id: playerSessionId,
        token_cache_hit: tokenCacheHit,
        verify_token_ms: verifyTokenMs,
        sql_profile_ms: sqlProfileMs,
        session_create_ms: sessionCreateMs,
        total_ms: Date.now() - totalStartedAt,
      });

      return NextResponse.json({
        sessionId: session.sessionId,
        playerSessionId,
        canonicalSessionId: playerSessionId,
        uid: session.uid,
        role: session.role,
        coadminUid: session.coadminUid,
        username: session.username,
        status: profile.status,
        expiresAt: session.expiresAt,
      });
    }

    const session = await createAppSessionForUser({
      uid: profile.uid,
      role: profile.role,
      coadminUid: profile.coadminUid,
      username: profile.username,
      deviceId,
      rawContext: {
        source: 'firebase_login_bootstrap',
      },
      deactivatePreviousForUid: profile.role === 'player',
    });
    const sessionCreateMs = Date.now() - sessionCreateStartedAt;

    logRouteSessionValidation('/api/auth/session/bootstrap', {
      ok: true,
      uid: profile.uid,
      role: profile.role,
      app_session_id: session.sessionId,
      validates: 'app_session_sql',
    });

    console.info('[SQL_AUTH_BOOTSTRAP]', {
      ok: true,
      uid: profile.uid,
      role: profile.role,
      sessionId: session.sessionId,
      token_cache_hit: tokenCacheHit,
      verify_token_ms: verifyTokenMs,
      sql_profile_ms: sqlProfileMs,
      session_create_ms: sessionCreateMs,
      total_ms: Date.now() - totalStartedAt,
    });

    return NextResponse.json({
      sessionId: session.sessionId,
      uid: session.uid,
      role: session.role,
      coadminUid: session.coadminUid,
      username: session.username,
      status: profile.status,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    console.info('[SQL_AUTH_BOOTSTRAP]', {
      ok: false,
      uid: profile.uid,
      role: profile.role,
      reason: 'session_create_failed',
      token_cache_hit: tokenCacheHit,
      verify_token_ms: verifyTokenMs,
      sql_profile_ms: sqlProfileMs,
      session_create_ms: Date.now() - sessionCreateStartedAt,
      total_ms: Date.now() - totalStartedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return apiError('Failed to create app session.', 500);
  }
}
