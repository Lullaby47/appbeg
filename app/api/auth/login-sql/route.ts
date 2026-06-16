import { NextResponse } from 'next/server';

import { verifyPassword } from '@/lib/auth/passwordHash';
import { isPlayerSessionSqlReadEnabled } from '@/lib/server/authSqlRead';
import { isAppbegSqlOnlyMode, isFirebaseFallbackAllowed } from '@/lib/server/appbegSqlOnlyMode';
import { mirrorPlayerSessionStartToFirestore } from '@/lib/server/playerSessionFirestoreMirror';
import { logSqlLoginNoFirestoreMirror } from '@/lib/server/sqlSessionNoFirestoreMirror';
import { createPlayerLoginSessionsInSql } from '@/lib/server/sqlPlayerLoginSessions';
import {
  evaluatePlayerSessionLoginDecision,
  logLoginSqlDecision,
} from '@/lib/server/playerSessionLoginDecision';
import { createAppSessionForUser } from '@/lib/sql/appSessions';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { lookupApiUserProfileByUsernameFromSqlCache, mirrorPlayerById } from '@/lib/sql/playersCache';
import { lookupUserCredentials } from '@/lib/sql/userCredentials';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

// TODO(rate-limit): add per-IP / per-username throttling for SQL login attempts.

type LoginSqlBody = {
  username?: unknown;
  password?: unknown;
  deviceId?: unknown;
};

type LoginSqlDiagReason =
  | 'invalid_json'
  | 'invalid_input'
  | 'profile_lookup_unavailable'
  | 'profile_not_found'
  | 'profile_deleted'
  | 'status_not_allowed'
  | 'credentials_not_found'
  | 'password_algo_mismatch'
  | 'password_verify_failed'
  | 'bootstrap_expected'
  | 'firebase_fallback_suppressed'
  | 'player_session_unavailable'
  | 'session_create_failed'
  | 'success'
  | 'unknown_error';

function isLoginAllowedStatus(status: string | null, role: string) {
  const normalizedStatus = cleanText(status).toLowerCase();
  const normalizedRole = cleanText(role).toLowerCase();
  const isActive = normalizedStatus === 'active';
  const isBlockedPlayer = normalizedStatus === 'disabled' && normalizedRole === 'player';
  return isActive || isBlockedPlayer;
}

function logLoginSqlDiagStart(values: { usernameNormalized: string; roleExpected?: string | null }) {
  console.info('[LOGIN_SQL_DIAG_START]', {
    usernameNormalized: values.usernameNormalized,
    roleExpected: values.roleExpected ?? null,
  });
}

function logLoginSqlDiagProfile(values: {
  found: boolean;
  uid?: string | null;
  role?: string | null;
  status?: string | null;
  deleted?: boolean | null;
}) {
  console.info('[LOGIN_SQL_DIAG_PROFILE]', {
    found: values.found,
    uid: values.uid ?? null,
    role: values.role ?? null,
    status: values.status ?? null,
    deleted: values.deleted ?? null,
  });
}

function logLoginSqlDiagCredentials(values: {
  found: boolean;
  passwordAlgo?: string | null;
  mustReset?: boolean | null;
}) {
  console.info('[LOGIN_SQL_DIAG_CREDENTIALS]', {
    found: values.found,
    passwordAlgo: values.passwordAlgo ?? null,
    mustReset: values.mustReset ?? null,
  });
}

function logLoginSqlDiagPassword(values: { verifyAttempted: boolean; verifyPassed: boolean }) {
  console.info('[LOGIN_SQL_DIAG_PASSWORD]', values);
}

function logLoginSqlDiagSession(values: { sessionAttempted: boolean; sessionCreated: boolean }) {
  console.info('[LOGIN_SQL_DIAG_SESSION]', values);
}

function logLoginSqlDiagResult(values: { success: boolean; reason: LoginSqlDiagReason }) {
  console.info('[LOGIN_SQL_DIAG_RESULT]', values);
}

function canReturnFirebaseFallback() {
  return !isAppbegSqlOnlyMode() && isFirebaseFallbackAllowed();
}

function logFirebaseFallbackSuppressed(
  reason: string,
  details?: Record<string, unknown>
) {
  console.info('[SQL_LOGIN_FIREBASE_FALLBACK_SUPPRESSED]', {
    reason,
    appbeg_sql_only_mode: isAppbegSqlOnlyMode(),
    allow_firebase_fallback: isFirebaseFallbackAllowed(),
    ...(details || {}),
  });
}

function failureResponse(
  reason: 'credentials_missing' | 'invalid_credentials' | 'server_unavailable',
  options?: { fallbackToFirebase?: boolean; status?: number }
) {
  const requestedFallbackToFirebase =
    options?.fallbackToFirebase ??
    (reason === 'credentials_missing' || reason === 'server_unavailable');
  const fallbackToFirebase = requestedFallbackToFirebase && canReturnFirebaseFallback();

  if (requestedFallbackToFirebase && !fallbackToFirebase) {
    logFirebaseFallbackSuppressed(reason, {
      response_reason: reason,
    });
  }

  return NextResponse.json(
    {
      ok: false,
      reason,
      ...(fallbackToFirebase ? { fallbackToFirebase: true } : {}),
    },
    { status: options?.status ?? (reason === 'server_unavailable' ? 503 : 401) }
  );
}

function schedulePlayerSessionStartFirestoreMirror(input: {
  playerUid: string;
  role: string;
  sessionId: string;
  appSessionId: string;
  deviceId: string;
  previousSessionIds: string[];
}) {
  if (isPlayerSessionSqlReadEnabled()) {
    logSqlLoginNoFirestoreMirror({
      route: '/api/auth/login-sql',
      uid: input.playerUid,
      role: input.role,
      playerSessionIdPrefix: input.sessionId.slice(0, 8),
      appSessionIdPrefix: input.appSessionId.slice(0, 8),
    });
    return;
  }
  void mirrorPlayerSessionStartToFirestore({
    playerUid: input.playerUid,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    previousSessionIds: input.previousSessionIds,
  })
    .then((firestoreMirrorOk) => {
      console.info('[PLAYER_SESSION_SQL]', {
        action: 'start_mirror_async',
        uid: input.playerUid,
        sessionId: input.sessionId,
        firestore_mirror_ok: firestoreMirrorOk,
        previousSessionCount: input.previousSessionIds.length,
      });
    })
    .catch((error) => {
      console.warn('[PLAYER_SESSION_SQL] firestore mirror failed', {
        action: 'start_mirror_async',
        uid: input.playerUid,
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export async function POST(request: Request) {
  const totalStartedAt = Date.now();
  let body: LoginSqlBody = {};
  try {
    body = (await request.json()) as LoginSqlBody;
  } catch {
    logLoginSqlDiagStart({ usernameNormalized: '', roleExpected: null });
    logLoginSqlDiagResult({ success: false, reason: 'invalid_json' });
    console.info(
      '[SQL_AUTH_LOGIN] ok=false uid=null role=null reason=invalid_json rate_limit=not_implemented lookup_ms=0 verify_ms=0 session_create_ms=0 total_ms=%s',
      Date.now() - totalStartedAt
    );
    return NextResponse.json({ ok: false, reason: 'invalid_credentials' }, { status: 400 });
  }

  const username = cleanText(body.username).toLowerCase();
  const password = String(body.password || '');
  const deviceId = cleanText(body.deviceId) || null;

  logLoginSqlDiagStart({ usernameNormalized: username, roleExpected: null });

  if (!username || password.length < 6) {
    logLoginSqlDiagResult({ success: false, reason: 'invalid_input' });
    console.info(
      '[SQL_AUTH_LOGIN] ok=false uid=null role=null reason=invalid_input rate_limit=not_implemented lookup_ms=0 verify_ms=0 session_create_ms=0 total_ms=%s',
      Date.now() - totalStartedAt
    );
    return NextResponse.json({ ok: false, reason: 'invalid_credentials' }, { status: 400 });
  }

  const lookupStartedAt = Date.now();
  const profileLookup = await lookupApiUserProfileByUsernameFromSqlCache(username);
  const lookupMs = Date.now() - lookupStartedAt;
  const profileFromSql = profileLookup.missReason === null && Boolean(profileLookup.profile);

  if (
    profileLookup.missReason === 'postgres_unavailable' ||
    profileLookup.missReason === 'lookup_failed'
  ) {
    console.info(
      '[SQL_AUTH_LOGIN] ok=false uid=null role=null reason=server_unavailable rate_limit=not_implemented lookup_ms=%s verify_ms=0 session_create_ms=0 total_ms=%s',
      lookupMs,
      Date.now() - totalStartedAt
    );
    logLoginSqlDiagProfile({ found: false, deleted: null });
    logLoginSqlDiagResult({ success: false, reason: 'profile_lookup_unavailable' });
    return failureResponse('server_unavailable', { fallbackToFirebase: true, status: 503 });
  }

  if (!profileLookup.profile) {
    console.info(
      '[SQL_AUTH_LOGIN] ok=false uid=null role=null reason=credentials_missing rate_limit=not_implemented lookup_ms=%s verify_ms=0 session_create_ms=0 total_ms=%s',
      lookupMs,
      Date.now() - totalStartedAt
    );
    logLoginSqlDiagProfile({ found: false, deleted: null });
    logLoginSqlDiagResult({ success: false, reason: 'profile_not_found' });
    return failureResponse('credentials_missing', { fallbackToFirebase: true });
  }

  const profile = profileLookup.profile;
  logLoginSqlDiagProfile({
    found: true,
    uid: profile.uid,
    role: profile.role,
    status: profile.status,
    deleted: false,
  });
  if (!isLoginAllowedStatus(profile.status, profile.role)) {
    console.info(
      '[SQL_AUTH_LOGIN] ok=false uid=%s role=%s reason=invalid_credentials rate_limit=not_implemented lookup_ms=%s verify_ms=0 session_create_ms=0 total_ms=%s',
      profile.uid,
      profile.role,
      lookupMs,
      Date.now() - totalStartedAt
    );
    logLoginSqlDiagResult({ success: false, reason: 'status_not_allowed' });
    return failureResponse('invalid_credentials', { fallbackToFirebase: false });
  }

  const credentials = await lookupUserCredentials(profile.uid);
  if (!credentials) {
    console.info(
      '[SQL_AUTH_LOGIN] ok=false uid=%s role=%s reason=credentials_missing rate_limit=not_implemented lookup_ms=%s verify_ms=0 session_create_ms=0 total_ms=%s',
      profile.uid,
      profile.role,
      lookupMs,
      Date.now() - totalStartedAt
    );
    logLoginSqlDiagCredentials({ found: false });
    logLoginSqlDiagPassword({ verifyAttempted: false, verifyPassed: false });
    logLoginSqlDiagResult({ success: false, reason: 'credentials_not_found' });
    return failureResponse('credentials_missing', { fallbackToFirebase: true });
  }

  logLoginSqlDiagCredentials({
    found: true,
    passwordAlgo: credentials.passwordAlgo,
    mustReset: credentials.mustReset,
  });

  const verifyStartedAt = Date.now();
  let passwordValid = false;
  try {
    passwordValid = await verifyPassword(password, credentials.passwordHash, credentials.passwordAlgo);
  } catch {
    passwordValid = false;
  }
  const verifyMs = Date.now() - verifyStartedAt;
  logLoginSqlDiagPassword({ verifyAttempted: true, verifyPassed: passwordValid });

  if (!passwordValid) {
    console.info(
      '[SQL_AUTH_LOGIN] ok=false uid=%s role=%s reason=invalid_credentials rate_limit=not_implemented lookup_ms=%s verify_ms=%s session_create_ms=0 total_ms=%s',
      profile.uid,
      profile.role,
      lookupMs,
      verifyMs,
      Date.now() - totalStartedAt
    );
    logLoginSqlDiagResult({
      success: false,
      reason: credentials.passwordAlgo !== 'bcrypt' ? 'password_algo_mismatch' : 'password_verify_failed',
    });
    return failureResponse('invalid_credentials', { fallbackToFirebase: false });
  }

  if (profile.role === 'player') {
    const sessionDecision = await evaluatePlayerSessionLoginDecision({
      uid: profile.uid,
      role: profile.role,
      deviceId,
      appSessionExists: false,
    });

    if (sessionDecision.decision === 'bootstrap_expected') {
      if (!canReturnFirebaseFallback()) {
        logLoginSqlDiagSession({ sessionAttempted: false, sessionCreated: false });
        logLoginSqlDecision({
          uid: profile.uid,
          role: profile.role,
          authenticated: true,
          playerSessionRequired: true,
          playerSessionExists: sessionDecision.playerSessionExists,
          bootstrapExpected: false,
          decision: 'deny',
          reason: 'bootstrap_expected_firebase_fallback_suppressed',
        });
        logFirebaseFallbackSuppressed('bootstrap_expected', {
          uid: profile.uid,
          role: profile.role,
          session_decision_reason: sessionDecision.reason,
        });

        console.info(
          '[SQL_AUTH_LOGIN] ok=false uid=%s role=player reason=bootstrap_expected_fallback_suppressed rate_limit=not_implemented lookup_ms=%s verify_ms=%s session_create_ms=0 total_ms=%s',
          profile.uid,
          lookupMs,
          verifyMs,
          Date.now() - totalStartedAt
        );

        logLoginSqlDiagResult({ success: false, reason: 'firebase_fallback_suppressed' });
        return failureResponse('server_unavailable', {
          fallbackToFirebase: true,
          status: 503,
        });
      }

      logLoginSqlDecision({
        uid: profile.uid,
        role: profile.role,
        authenticated: true,
        playerSessionRequired: true,
        playerSessionExists: sessionDecision.playerSessionExists,
        bootstrapExpected: true,
        decision: 'bootstrap_expected',
        reason: sessionDecision.reason,
      });

      console.info(
        '[SQL_AUTH_LOGIN] ok=true uid=%s role=player reason=bootstrap_expected rate_limit=not_implemented lookup_ms=%s verify_ms=%s session_create_ms=0 total_ms=%s',
        profile.uid,
        lookupMs,
        verifyMs,
        Date.now() - totalStartedAt
      );

      logLoginSqlDiagSession({ sessionAttempted: false, sessionCreated: false });
      logLoginSqlDiagResult({ success: true, reason: 'bootstrap_expected' });
      return NextResponse.json({
        ok: true,
        authenticated: true,
        bootstrapExpected: true,
        uid: profile.uid,
        role: 'player',
        coadminUid: profile.coadminUid,
        username: profile.username,
        status: profile.status,
      });
    }

    if (!deviceId) {
      console.info(
        '[SQL_AUTH_LOGIN] ok=false uid=%s role=player reason=server_unavailable rate_limit=not_implemented lookup_ms=%s verify_ms=%s session_create_ms=0 total_ms=%s',
        profile.uid,
        lookupMs,
        verifyMs,
        Date.now() - totalStartedAt
      );
      logLoginSqlDiagSession({ sessionAttempted: false, sessionCreated: false });
      logLoginSqlDiagResult({ success: false, reason: 'player_session_unavailable' });
      return failureResponse('server_unavailable', { fallbackToFirebase: true, status: 503 });
    }

    const sessionCreateStartedAt = Date.now();
    let cacheSeedMs = 0;

    if (!profileFromSql) {
      const cacheSeedStartedAt = Date.now();
      try {
        await mirrorPlayerById(profile.uid, 'sql_player_login_hydrate');
      } catch (error) {
        console.warn('[SQL_AUTH_LOGIN] players_cache hydrate failed', {
          uid: profile.uid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      cacheSeedMs = Date.now() - cacheSeedStartedAt;
    }

    try {
      logLoginSqlDiagSession({ sessionAttempted: true, sessionCreated: false });
      logLoginSqlDecision({
        uid: profile.uid,
        role: profile.role,
        authenticated: true,
        playerSessionRequired: true,
        playerSessionExists: sessionDecision.playerSessionExists,
        bootstrapExpected: false,
        decision: 'inline_sql_sessions',
        reason: sessionDecision.reason,
      });

      const loginSessions = await createPlayerLoginSessionsInSql({
        playerUid: profile.uid,
        deviceId,
        role: profile.role,
        coadminUid: profile.coadminUid,
        username: profile.username,
        actorSource: 'sql_player_login',
        appSessionRawContext: {
          source: 'sql_login',
          authPath: 'sql_login',
        },
      });

      const playerSessionId = loginSessions.playerSessionId;
      const session = loginSessions.appSession;
      const previousSessionIds = loginSessions.previousSessionIds;
      const sessionCreateMs = Date.now() - sessionCreateStartedAt;

      console.info('[SQL_PLAYER_LOGIN_SESSION_TIMING]', {
        start_player_session_sql_ms: loginSessions.timing.start_player_session_sql_ms,
        create_app_session_ms: loginSessions.timing.create_app_session_ms,
        firestore_mirror_ms: 0,
        cache_seed_ms: cacheSeedMs,
        cache_invalidation_ms: loginSessions.timing.cache_invalidation_ms,
        pool_acquire_ms: loginSessions.timing.pool_acquire_ms,
        previous_session_count: loginSessions.timing.previous_session_count,
        shared_client: loginSessions.timing.shared_client,
        total_ms: sessionCreateMs,
      });

      console.info('[SQL_PLAYER_LOGIN_SESSION_QUERY_TIMING]', loginSessions.timing.query_timing);

      schedulePlayerSessionStartFirestoreMirror({
        playerUid: profile.uid,
        role: profile.role,
        sessionId: playerSessionId,
        appSessionId: session.sessionId,
        deviceId,
        previousSessionIds,
      });

      console.info('[SQL_AUTH_LOGIN]', {
        role: 'player',
        uid: profile.uid,
        player_session_sql_ok: true,
        firestore_mirror_ok: null,
        firestore_mirror_async: isPlayerSessionSqlReadEnabled() ? null : true,
        playerSessionId,
        lookup_ms: lookupMs,
        verify_ms: verifyMs,
        session_create_ms: sessionCreateMs,
        total_ms: Date.now() - totalStartedAt,
      });

      logLoginSqlDiagSession({ sessionAttempted: true, sessionCreated: true });
      logLoginSqlDiagResult({ success: true, reason: 'success' });
      return NextResponse.json({
        ok: true,
        sessionId: session.sessionId,
        uid: session.uid,
        role: 'player',
        coadminUid: session.coadminUid,
        username: session.username || profile.username,
        status: profile.status,
        expiresAt: session.expiresAt,
        playerSessionId,
        canonicalSessionId: playerSessionId,
        playerSessionSource: 'sql',
      });
    } catch (error) {
      console.info('[SQL_AUTH_LOGIN]', {
        role: 'player',
        uid: profile.uid,
        player_session_sql_ok: false,
        firestore_mirror_ok: false,
        reason: 'player_session_create_failed',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - totalStartedAt,
      });
      logLoginSqlDiagSession({ sessionAttempted: true, sessionCreated: false });
      logLoginSqlDiagResult({ success: false, reason: 'session_create_failed' });
      return failureResponse('server_unavailable', { fallbackToFirebase: true, status: 503 });
    }
  }

  const sessionCreateStartedAt = Date.now();
  try {
    logLoginSqlDiagSession({ sessionAttempted: true, sessionCreated: false });
    const session = await createAppSessionForUser({
      uid: profile.uid,
      role: profile.role,
      coadminUid: profile.coadminUid,
      username: profile.username,
      deviceId,
      rawContext: {
        source: 'sql_login',
        authPath: 'sql_login',
      },
      deactivatePreviousForUid: false,
    });
    const sessionCreateMs = Date.now() - sessionCreateStartedAt;

    console.info(
      '[SQL_AUTH_LOGIN] ok=true uid=%s role=%s reason=success rate_limit=not_implemented lookup_ms=%s verify_ms=%s session_create_ms=%s total_ms=%s',
      profile.uid,
      profile.role,
      lookupMs,
      verifyMs,
      sessionCreateMs,
      Date.now() - totalStartedAt
    );

    logLoginSqlDiagSession({ sessionAttempted: true, sessionCreated: true });
    logLoginSqlDiagResult({ success: true, reason: 'success' });
    return NextResponse.json({
      ok: true,
      sessionId: session.sessionId,
      uid: session.uid,
      role: session.role,
      coadminUid: session.coadminUid,
      username: session.username || profile.username,
      status: profile.status,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    console.info(
      '[SQL_AUTH_LOGIN] ok=false uid=%s role=%s reason=server_unavailable rate_limit=not_implemented lookup_ms=%s verify_ms=%s session_create_ms=%s total_ms=%s error=%s',
      profile.uid,
      profile.role,
      lookupMs,
      verifyMs,
      Date.now() - sessionCreateStartedAt,
      Date.now() - totalStartedAt,
      error instanceof Error ? error.message : String(error)
    );
    logLoginSqlDiagSession({ sessionAttempted: true, sessionCreated: false });
    logLoginSqlDiagResult({ success: false, reason: 'session_create_failed' });
    return failureResponse('server_unavailable', { fallbackToFirebase: true, status: 503 });
  }
}
