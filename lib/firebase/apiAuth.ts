import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { verifyLiveCarerApiToken } from '@/lib/firebase/liveAuthTokenCache';
import {
  lookupAppSession,
  lookupAppSessionWithClient,
  touchAppSession,
  type AppSessionRow,
} from '@/lib/sql/appSessions';
import {
  acquirePlayerMirrorClient,
  cleanText,
  type PlayerMirrorAcquireContext,
} from '@/lib/sql/playerMirrorCommon';
import {
  lookupApiUserProfileFromSqlCache,
  lookupCarerProfileFromSqlCache,
  lookupPlayerProfileFromSqlCache,
  mirrorPlayerById,
  type ApiUserSqlProfileLookup,
} from '@/lib/sql/playersCache';
import {
  getCachedPlayerSessionValidation,
  writePlayerSessionAuthCache,
} from '@/lib/server/playerSessionAuthCache';
import {
  lookupPlayerSessionFromSqlCache,
  mirrorPlayerSessionById,
} from '@/lib/sql/playerSessionsCache';
import { timedRechargeFirestoreRead } from '@/lib/server/rechargeFirestoreInstrumentation';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';

export type ApiRole = 'admin' | 'coadmin' | 'staff' | 'carer' | 'player';

export type ApiUser = {
  uid: string;
  role: ApiRole;
  username: string;
  coadminUid: string | null;
  createdBy: string | null;
  automationAgentId?: string | null;
};

function bearerToken(request: Request) {
  return (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1] || '';
}

function playerSessionId(request: Request) {
  return String(request.headers.get('X-Player-Session-Id') || '').trim();
}

function appSessionIdFromRequest(request: Request) {
  return cleanText(request.headers.get('X-App-Session-Id'));
}

function isLoginAllowedStatus(status: string | null, role: string) {
  const normalizedStatus = cleanText(status).toLowerCase();
  const normalizedRole = cleanText(role).toLowerCase();
  const isActive = normalizedStatus === 'active';
  const isBlockedPlayer = normalizedStatus === 'disabled' && normalizedRole === 'player';
  return isActive || isBlockedPlayer;
}

const APP_SESSION_TOUCH_THROTTLE_MS = 60_000;
const APP_SESSION_AUTH_CACHE_TTL_MS = 30_000;
const lastAppSessionTouchAt = new Map<string, number>();

export type AppSessionAuthTiming = {
  cookie_parse_ms: number;
  cache_lookup_ms: number;
  pool_acquire_ms: number;
  session_lookup_ms: number;
  profile_lookup_ms: number;
  client_release_ms: number;
  auth_finalize_ms: number;
  total_ms: number;
};

function emptyAppSessionAuthTiming(
  partial: Partial<AppSessionAuthTiming> = {}
): AppSessionAuthTiming {
  return {
    cookie_parse_ms: partial.cookie_parse_ms ?? 0,
    cache_lookup_ms: partial.cache_lookup_ms ?? 0,
    pool_acquire_ms: partial.pool_acquire_ms ?? 0,
    session_lookup_ms: partial.session_lookup_ms ?? 0,
    profile_lookup_ms: partial.profile_lookup_ms ?? 0,
    client_release_ms: partial.client_release_ms ?? 0,
    auth_finalize_ms: partial.auth_finalize_ms ?? 0,
    total_ms: partial.total_ms ?? 0,
  };
}

export type AppSessionVerifyResult =
  | {
      hit: false;
      sessionId: string | null;
      reason: string;
      lookupMs: number;
      timing: AppSessionAuthTiming;
    }
  | {
      hit: true;
      sessionId: string;
      uid: string;
      role: ApiRole;
      coadminUid: string | null;
      username: string;
      session: AppSessionRow;
      profile: ApiUserSqlProfileLookup;
      lookupMs: number;
      profileMs: number;
      authPath: 'app_session_sql';
      timing: AppSessionAuthTiming;
    };

type AppSessionAuthCachePayload = Omit<
  Extract<AppSessionVerifyResult, { hit: true }>,
  'timing'
>;

type AppSessionAuthCacheEntry = {
  expiresAt: number;
  result: AppSessionAuthCachePayload;
};

const appSessionAuthCache = new Map<string, AppSessionAuthCacheEntry>();

export function invalidateAppSessionAuthCache(sessionId?: string) {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId) {
    appSessionAuthCache.clear();
    return;
  }
  appSessionAuthCache.delete(cleanSessionId);
}

function readAppSessionAuthCache(sessionId: string): AppSessionAuthCachePayload | null {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId) {
    return null;
  }
  const cached = appSessionAuthCache.get(cleanSessionId);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    appSessionAuthCache.delete(cleanSessionId);
    return null;
  }
  if (new Date(cached.result.session.expiresAt).getTime() <= Date.now()) {
    appSessionAuthCache.delete(cleanSessionId);
    return null;
  }
  return cached.result;
}

function writeAppSessionAuthCache(sessionId: string, result: AppSessionAuthCachePayload) {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId) {
    return;
  }
  appSessionAuthCache.set(cleanSessionId, {
    expiresAt: Date.now() + APP_SESSION_AUTH_CACHE_TTL_MS,
    result,
  });
}

function mirrorAcquireContextFromRequest(
  request: Request,
  context: string
): PlayerMirrorAcquireContext {
  try {
    return { context, route: new URL(request.url).pathname };
  } catch {
    return { context };
  }
}

export async function verifyAppSessionFromRequest(
  request: Request,
  options?: { mirrorClient?: PoolClient; acquireContext?: PlayerMirrorAcquireContext }
): Promise<AppSessionVerifyResult> {
  const verifyStartedAt = Date.now();
  const cookieParseStartedAt = Date.now();
  const sessionId = appSessionIdFromRequest(request);
  const timing = emptyAppSessionAuthTiming({
    cookie_parse_ms: Date.now() - cookieParseStartedAt,
  });

  if (!sessionId) {
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info('[APP_SESSION_AUTH] hit=false sessionId=null reason=missing_header', timing);
    return { hit: false, sessionId: null, reason: 'missing_header', lookupMs: 0, timing };
  }

  const cacheLookupStartedAt = Date.now();
  const cachedAuth = readAppSessionAuthCache(sessionId);
  timing.cache_lookup_ms = Date.now() - cacheLookupStartedAt;

  if (cachedAuth) {
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info('[APP_SESSION_AUTH_CACHE]', {
      hit: true,
      uid: cachedAuth.uid,
      role: cachedAuth.role,
      sessionIdPrefix: sessionId.slice(0, 8),
      durationMs: timing.total_ms,
      ...timing,
    });
    return {
      ...cachedAuth,
      lookupMs: 0,
      profileMs: 0,
      timing,
    };
  }

  console.info('[APP_SESSION_AUTH_CACHE]', {
    hit: false,
    uid: null,
    role: null,
    sessionIdPrefix: sessionId.slice(0, 8),
    durationMs: Date.now() - verifyStartedAt,
    cache_lookup_ms: timing.cache_lookup_ms,
  });

  const ownsMirrorClient = !options?.mirrorClient;
  const poolAcquireStartedAt = Date.now();
  const acquiredMirror = ownsMirrorClient
    ? await acquirePlayerMirrorClient(
        options?.acquireContext ?? mirrorAcquireContextFromRequest(request, 'app_session_auth')
      )
    : null;
  timing.pool_acquire_ms = ownsMirrorClient
    ? acquiredMirror?.timing.pool_acquire_ms ?? Date.now() - poolAcquireStartedAt
    : 0;
  const mirrorClient = options?.mirrorClient ?? acquiredMirror?.client ?? null;

  const lookupStartedAt = Date.now();
  const session = mirrorClient
    ? await lookupAppSessionWithClient(sessionId, mirrorClient)
    : await lookupAppSession(sessionId);
  timing.session_lookup_ms = Date.now() - lookupStartedAt;
  const lookupMs = timing.session_lookup_ms;

  if (!session) {
    const releaseStartedAt = Date.now();
    if (acquiredMirror) {
      acquiredMirror.client.release();
    }
    timing.client_release_ms = Date.now() - releaseStartedAt;
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info(
      '[APP_SESSION_AUTH] hit=false uid=null role=null sessionId=%s reason=invalid_or_expired lookup_ms=%s pool_acquire_ms=%s session_lookup_ms=%s client_release_ms=%s total_ms=%s',
      sessionId,
      lookupMs,
      timing.pool_acquire_ms,
      timing.session_lookup_ms,
      timing.client_release_ms,
      timing.total_ms
    );
    return { hit: false, sessionId, reason: 'invalid_or_expired', lookupMs, timing };
  }

  const now = Date.now();
  const lastTouch = lastAppSessionTouchAt.get(sessionId) || 0;
  if (now - lastTouch >= APP_SESSION_TOUCH_THROTTLE_MS) {
    void touchAppSession(sessionId);
    lastAppSessionTouchAt.set(sessionId, now);
  }

  const profileStartedAt = Date.now();
  let profileLookup;
  try {
    profileLookup = mirrorClient
      ? await lookupApiUserProfileFromSqlCache(session.uid, mirrorClient)
      : await lookupApiUserProfileFromSqlCache(session.uid);
  } finally {
    const releaseStartedAt = Date.now();
    if (acquiredMirror) {
      acquiredMirror.client.release();
    }
    timing.client_release_ms = Date.now() - releaseStartedAt;
  }
  timing.profile_lookup_ms = Date.now() - profileStartedAt - timing.client_release_ms;
  const profileMs = timing.profile_lookup_ms;

  if (!profileLookup.profile) {
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info(
      '[APP_SESSION_AUTH] hit=false uid=%s role=%s sessionId=%s reason=%s lookup_ms=%s profile_ms=%s pool_acquire_ms=%s session_lookup_ms=%s profile_lookup_ms=%s client_release_ms=%s total_ms=%s',
      session.uid,
      session.role,
      sessionId,
      profileLookup.missReason || 'profile_missing',
      lookupMs,
      profileMs,
      timing.pool_acquire_ms,
      timing.session_lookup_ms,
      timing.profile_lookup_ms,
      timing.client_release_ms,
      timing.total_ms
    );
    return {
      hit: false,
      sessionId,
      reason: profileLookup.missReason || 'profile_missing',
      lookupMs,
      timing,
    };
  }

  const profile = profileLookup.profile;
  if (!isLoginAllowedStatus(profile.status, profile.role)) {
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info(
      '[APP_SESSION_AUTH] hit=false uid=%s role=%s sessionId=%s reason=account_not_active lookup_ms=%s profile_ms=%s pool_acquire_ms=%s total_ms=%s',
      session.uid,
      profile.role,
      sessionId,
      lookupMs,
      profileMs,
      timing.pool_acquire_ms,
      timing.total_ms
    );
    return { hit: false, sessionId, reason: 'account_not_active', lookupMs, timing };
  }

  if (profile.uid !== session.uid) {
    timing.total_ms = Date.now() - verifyStartedAt;
    console.info(
      '[APP_SESSION_AUTH] hit=false uid=%s role=%s sessionId=%s reason=uid_mismatch lookup_ms=%s profile_ms=%s pool_acquire_ms=%s total_ms=%s',
      session.uid,
      session.role,
      sessionId,
      lookupMs,
      profileMs,
      timing.pool_acquire_ms,
      timing.total_ms
    );
    return { hit: false, sessionId, reason: 'uid_mismatch', lookupMs, timing };
  }

  const role = profile.role as ApiRole;
  const finalizeStartedAt = Date.now();
  const verified: AppSessionAuthCachePayload = {
    hit: true,
    sessionId,
    uid: session.uid,
    role,
    coadminUid: profile.coadminUid,
    username: profile.username,
    session,
    profile,
    lookupMs,
    profileMs,
    authPath: 'app_session_sql',
  };
  writeAppSessionAuthCache(sessionId, verified);
  timing.auth_finalize_ms = Date.now() - finalizeStartedAt;
  timing.total_ms = Date.now() - verifyStartedAt;

  console.info(
    '[APP_SESSION_AUTH] hit=true uid=%s role=%s sessionId=%s lookup_ms=%s profile_ms=%s shared_client=%s pool_acquire_ms=%s session_lookup_ms=%s profile_lookup_ms=%s client_release_ms=%s auth_finalize_ms=%s total_ms=%s',
    session.uid,
    role,
    sessionId,
    lookupMs,
    profileMs,
    Boolean(mirrorClient),
    timing.pool_acquire_ms,
    timing.session_lookup_ms,
    timing.profile_lookup_ms,
    timing.client_release_ms,
    timing.auth_finalize_ms,
    timing.total_ms
  );

  return { ...verified, timing };
}

export function apiError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function verifyApiTokenIdentity(
  request: Request
): Promise<{ uid: string } | { response: NextResponse }> {
  const token = bearerToken(request);
  if (!token) {
    return { response: apiError('Missing or invalid authorization.', 401) };
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return { uid: decoded.uid };
  } catch {
    return { response: apiError('Invalid or expired authorization token.', 401) };
  }
}

export type PlayerLiveAuthPath =
  | 'app_session_sql_session_sql'
  | 'app_session_sql_session_firestore'
  | 'player_token_sql_session_sql'
  | 'player_token_sql_session_firestore'
  | 'player_token_firestore_session_sql'
  | 'player_token_firestore_session_firestore';

export type PlayerLiveAuthTiming = {
  auth_path: PlayerLiveAuthPath;
  verify_token_ms: number;
  sql_profile_ms: number;
  sql_profile_pool_acquire_ms: number;
  sql_profile_query_exec_ms: number;
  sql_profile_total_ms: number;
  session_sql_ms: number;
  session_sql_pool_acquire_ms: number;
  session_sql_query_exec_ms: number;
  session_sql_total_ms: number;
  /** @deprecated Use sql_profile_total_ms for SQL path; user_doc_ms for Firestore fallback */
  user_doc_ms: number;
  session_doc_ms: number;
  session_source: 'sql' | 'firestore' | 'none';
  session_check_ms: number;
  auth_ms: number;
  token_cache_hit: boolean;
  request_session_id?: string | null;
  active_session_id?: string | null;
};

function playerSessionBlockedResponse() {
  return apiError(
    'You were logged out because this account logged in on another device.',
    401
  );
}

function resolvePlayerLiveAuthPath(
  usedSqlProfile: boolean,
  sessionSource: 'sql' | 'firestore' | 'none'
): PlayerLiveAuthPath {
  const profilePart = usedSqlProfile ? 'sql' : 'firestore';
  const sessionPart = sessionSource === 'sql' ? 'sql' : 'firestore';
  return `player_token_${profilePart}_session_${sessionPart}` as PlayerLiveAuthPath;
}

export type ApiUserAuthPath =
  | 'app_session_sql'
  | 'app_session_sql_session_sql'
  | 'app_session_sql_session_firestore'
  | 'api_user_sql'
  | 'api_user_sql_session_sql'
  | 'api_user_sql_session_firestore'
  | 'api_user_firestore';

export type ApiUserAuthTiming = {
  auth_path: ApiUserAuthPath;
  verify_token_ms: number;
  sql_profile_ms: number;
  sql_session_ms: number;
  user_doc_ms: number;
  session_doc_ms: number;
  session_source: 'sql' | 'firestore' | 'none';
  auth_ms: number;
  token_cache_hit: boolean;
};

function apiUserFromSqlProfile(profile: ApiUserSqlProfileLookup): ApiUser {
  return {
    uid: profile.uid,
    role: profile.role as ApiRole,
    username: profile.username,
    coadminUid: profile.coadminUid,
    createdBy: profile.createdBy,
    automationAgentId: profile.automationAgentId,
  };
}

function apiUserFromFirestore(uid: string, data: Record<string, unknown>): ApiUser {
  const role = String(data.role || '').toLowerCase() as ApiRole;
  return {
    uid,
    role,
    username: String(data.username || ''),
    coadminUid: String(data.coadminUid || data.createdBy || '').trim() || null,
    createdBy: String(data.createdBy || '').trim() || null,
    automationAgentId: String(data.automationAgentId || '').trim() || null,
  };
}

type PlayerApiSessionTiming = {
  sql_session_ms?: number;
  session_doc_ms?: number;
  session_source?: 'sql' | 'firestore' | 'none';
  session_sql_ms?: number;
  session_sql_pool_acquire_ms?: number;
  session_sql_query_exec_ms?: number;
  session_sql_total_ms?: number;
};

function applyPlayerSessionAuthCacheHit(
  timing: PlayerApiSessionTiming,
  sessionSource: 'sql' | 'firestore'
) {
  if ('sql_session_ms' in timing) {
    timing.sql_session_ms = 0;
  }
  if ('session_doc_ms' in timing) {
    timing.session_doc_ms = 0;
  }
  timing.session_source = sessionSource;
  if ('session_sql_ms' in timing) {
    timing.session_sql_ms = 0;
    timing.session_sql_pool_acquire_ms = 0;
    timing.session_sql_query_exec_ms = 0;
    timing.session_sql_total_ms = 0;
  }
}

async function validatePlayerApiSession(
  uid: string,
  sessionId: string,
  timing: PlayerApiSessionTiming,
  options?: {
    appSessionId?: string;
    rechargeFirestoreInstrumentation?: boolean;
    sqlOnly?: boolean;
  }
): Promise<{ ok: true; sessionSource: 'sql' | 'firestore' } | { ok: false; response: NextResponse }> {
  const appSessionId = cleanText(options?.appSessionId);
  const cached = getCachedPlayerSessionValidation({
    appSessionId,
    playerSessionId: sessionId,
    uid,
  });
  if (cached.hit) {
    if (!cached.validation.ok) {
      applyPlayerSessionAuthCacheHit(timing, cached.validation.sessionSource);
      console.info('[API_AUTH] player request blocked', {
        uid,
        reason: cached.validation.reason || 'cached_session_invalid',
        sessionId,
        context: 'api_user_session',
        cache_hit: true,
      });
      return { ok: false, response: playerSessionBlockedResponse() };
    }

    applyPlayerSessionAuthCacheHit(timing, cached.validation.sessionSource);
    return { ok: true, sessionSource: cached.validation.sessionSource };
  }

  const sessionSqlStartedAt = Date.now();
  const sessionSqlLookup = await lookupPlayerSessionFromSqlCache(sessionId, uid);
  const sessionSqlMs = Date.now() - sessionSqlStartedAt;
  if ('sql_session_ms' in timing) {
    timing.sql_session_ms = sessionSqlMs;
  }
  if ('session_sql_ms' in timing) {
    timing.session_sql_ms = sessionSqlMs;
    timing.session_sql_pool_acquire_ms = sessionSqlLookup.timing.pool_acquire_ms;
    timing.session_sql_query_exec_ms = sessionSqlLookup.timing.query_exec_ms;
    timing.session_sql_total_ms = sessionSqlLookup.timing.total_ms;
  }

  if (sessionSqlLookup.missReason === null) {
    timing.session_source = 'sql';
    writePlayerSessionAuthCache(
      { appSessionId, playerSessionId: sessionId, uid },
      {
        ok: true,
        active: true,
        uid,
        activeSessionId: sessionId,
        sessionId,
        replaced: false,
        source: 'sql',
      },
      { reason: 'api_auth_sql_success' }
    );
    return { ok: true, sessionSource: 'sql' };
  }

  console.info(
    '[API_AUTH_FIRESTORE_FALLBACK] reason=%s uid=%s sessionId=%s context=api_user_session',
    sessionSqlLookup.missReason,
    uid,
    sessionId
  );

  if (options?.sqlOnly) {
    console.info('[API_AUTH] player request blocked', {
      uid,
      reason: sessionSqlLookup.missReason || 'sql_session_missing',
      sessionId,
      context: 'api_user_session_sql_only',
    });
    return {
      ok: false,
      response: apiError('Player session not found in SQL.', 401),
    };
  }

  const sessionDocStartedAt = Date.now();
  const sessionSnap = options?.rechargeFirestoreInstrumentation
    ? await timedRechargeFirestoreRead(
        {
          stage: 'auth_player_session',
          collection: 'playerSessions',
          document: sessionId,
        },
        () => adminDb.collection('playerSessions').doc(sessionId).get()
      )
    : await adminDb.collection('playerSessions').doc(sessionId).get();
  timing.session_doc_ms = Date.now() - sessionDocStartedAt;
  timing.session_source = 'firestore';

  const sessionData = sessionSnap.data() || {};
  if (
    !sessionSnap.exists ||
    String(sessionData.playerUid || '') !== uid ||
    sessionData.active !== true
  ) {
    const reason = !sessionSnap.exists
      ? 'session_doc_missing'
      : String(sessionData.playerUid || '') !== uid
        ? 'session_uid_mismatch'
        : 'session_doc_inactive';
    writePlayerSessionAuthCache(
      { appSessionId, playerSessionId: sessionId, uid },
      {
        ok: false,
        reason: 'session_inactive',
        uid,
        activeSessionId: sessionId,
        sessionId,
        source: 'firestore_fallback',
      },
      { reason: 'api_auth_firestore_inactive' }
    );
    console.info('[API_AUTH] player request blocked', {
      uid,
      reason,
      sessionId,
      context: 'api_user_session',
    });
    return { ok: false, response: playerSessionBlockedResponse() };
  }

  try {
    const mirrored = await mirrorPlayerSessionById(sessionId, 'api_user_session_hydrate');
    if (!mirrored) {
      console.info(
        '[API_AUTH_FIRESTORE_FALLBACK] reason=hydrate_failed uid=%s sessionId=%s context=api_user_session',
        uid,
        sessionId
      );
    }
  } catch (error) {
    console.info(
      '[API_AUTH_FIRESTORE_FALLBACK] reason=hydrate_failed uid=%s sessionId=%s error=%s context=api_user_session',
      uid,
      sessionId,
      error
    );
  }

  writePlayerSessionAuthCache(
    { appSessionId, playerSessionId: sessionId, uid },
    {
      ok: true,
      active: true,
      uid,
      activeSessionId: sessionId,
      sessionId,
      replaced: false,
      source: 'firestore_fallback',
    },
    { reason: 'api_auth_firestore_success' }
  );
  return { ok: true, sessionSource: 'firestore' };
}

async function authenticateApiUserFromAppSession(
  request: Request,
  allowedRoles: ApiRole[],
  timing: ApiUserAuthTiming,
  options?: { rechargeFirestoreInstrumentation?: boolean }
): Promise<{ user: ApiUser; authPath: ApiUserAuthPath } | { response: NextResponse } | null> {
  const sessionId = appSessionIdFromRequest(request);
  if (!sessionId) {
    return null;
  }

  const appSessionAuth = await verifyAppSessionFromRequest(request, {
    acquireContext: mirrorAcquireContextFromRequest(request, 'api_user_auth'),
  });
  if (!appSessionAuth.hit) {
    console.info('[APP_SESSION_AUTH] api_user_path_skipped', {
      reason: appSessionAuth.reason,
      sessionIdPrefix: sessionId.slice(0, 8),
    });
    return null;
  }

  const { profile, session } = appSessionAuth;
  timing.sql_profile_ms = appSessionAuth.profileMs;
  const role = profile.role as ApiRole;

  if (!allowedRoles.includes(role)) {
    console.info('[API_AUTH] request blocked', {
      uid: session.uid,
      role,
      allowedRoles,
      auth_path: 'app_session_sql',
      reason: 'role_not_allowed',
    });
    return { response: apiError('Forbidden.', 403) };
  }

  if (role === 'player') {
    const sessionHeaderId = playerSessionId(request);
    if (!sessionHeaderId) {
      return null;
    }

    const activeSessionId = String(profile.activeSessionId || '').trim();
    if (!activeSessionId || sessionHeaderId !== activeSessionId) {
      console.info('[API_AUTH] player request blocked', {
        uid: session.uid,
        reason: !activeSessionId ? 'missing_active_session_id' : 'session_mismatch',
        sessionId: sessionHeaderId || null,
        activeSessionId: activeSessionId || null,
        auth_path: 'app_session_sql',
      });
      return { response: playerSessionBlockedResponse() };
    }

    const sessionValidation = await validatePlayerApiSession(session.uid, sessionHeaderId, timing, {
      appSessionId: sessionId,
      rechargeFirestoreInstrumentation: options?.rechargeFirestoreInstrumentation,
    });
    if (!sessionValidation.ok) {
      return { response: sessionValidation.response };
    }

    const authPath: ApiUserAuthPath =
      sessionValidation.sessionSource === 'sql'
        ? 'app_session_sql_session_sql'
        : 'app_session_sql_session_firestore';
    timing.auth_path = authPath;
    timing.session_source = sessionValidation.sessionSource;

    const user = apiUserFromSqlProfile(profile);
    console.info('[API_AUTH] player request allowed', {
      uid: session.uid,
      sessionId: sessionHeaderId,
      reason: 'session_match',
      auth_path: authPath,
      session_source: timing.session_source,
    });
    return { user, authPath };
  }

  timing.auth_path = 'app_session_sql';
  const user = apiUserFromSqlProfile(profile);
  return { user, authPath: 'app_session_sql' };
}

export async function requirePlayerOwnedLiveAuth(
  request: Request,
  expectedPlayerUid: string
): Promise<
  | { ok: true; uid: string; timing: PlayerLiveAuthTiming }
  | { ok: false; response: NextResponse; timing: PlayerLiveAuthTiming }
> {
  const authStartedAt = Date.now();
  const expectedUid = String(expectedPlayerUid || '').trim();
  const sqlReadMode = isAuthSqlReadEnabled();
  const timing: PlayerLiveAuthTiming = {
    auth_path: sqlReadMode
      ? 'player_token_sql_session_sql'
      : 'player_token_firestore_session_firestore',
    verify_token_ms: 0,
    sql_profile_ms: 0,
    sql_profile_pool_acquire_ms: 0,
    sql_profile_query_exec_ms: 0,
    sql_profile_total_ms: 0,
    session_sql_ms: 0,
    session_sql_pool_acquire_ms: 0,
    session_sql_query_exec_ms: 0,
    session_sql_total_ms: 0,
    user_doc_ms: 0,
    session_doc_ms: 0,
    session_source: 'none',
    session_check_ms: 0,
    auth_ms: 0,
    token_cache_hit: false,
  };

  if (!expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const sessionId = playerSessionId(request);
  const appSessionId = appSessionIdFromRequest(request);
  timing.request_session_id = sessionId || null;

  const logPlayerLiveAuthBlocked = (
    uid: string,
    reason: string,
    extra?: { activeSessionId?: string | null }
  ) => {
    if (extra?.activeSessionId !== undefined) {
      timing.active_session_id = extra.activeSessionId;
    }
    console.info('[API_AUTH] player request blocked', {
      uid,
      reason,
      auth_path: timing.auth_path,
      session_source: timing.session_source,
      request_session_id: timing.request_session_id,
      active_session_id: timing.active_session_id ?? null,
      sql_read_mode: sqlReadMode,
    });
  };

  const finishPlayerLiveAuth = (
    uid: string,
    authPath: PlayerLiveAuthPath,
    sessionSource: 'sql' | 'firestore',
    activeSessionId?: string | null
  ) => {
    timing.auth_path = authPath;
    timing.session_source = sessionSource;
    timing.active_session_id = activeSessionId ?? sessionId ?? null;
    console.info('[API_AUTH] player request allowed', {
      uid,
      reason: 'session_match',
      auth_path: timing.auth_path,
      session_source: timing.session_source,
      request_session_id: timing.request_session_id,
      active_session_id: timing.active_session_id,
      token_cache_hit: timing.token_cache_hit,
      sql_profile_ms: timing.sql_profile_total_ms,
      session_sql_ms: timing.session_sql_total_ms,
      user_doc_ms: timing.user_doc_ms,
      session_doc_ms: timing.session_doc_ms,
      sql_read_mode: sqlReadMode,
    });
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: true as const, uid, timing };
  };

  const appSessionAuth = await verifyAppSessionFromRequest(request);
  if (appSessionAuth.hit && appSessionAuth.profile.role === 'player') {
    if (appSessionAuth.uid !== expectedUid) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('Forbidden.', 403), timing };
    }

    if (!sessionId) {
      console.info('[API_AUTH] player request blocked', {
        uid: appSessionAuth.uid,
        reason: 'missing_session_header',
        sessionId: null,
        auth_path: 'app_session_sql',
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('X-Player-Session-Id header is required.', 401), timing };
    }

    const sessionCheckStartedAt = Date.now();
    const sessionValidation = await validatePlayerApiSession(
      appSessionAuth.uid,
      sessionId,
      timing,
      {
        appSessionId: appSessionAuth.sessionId,
        sqlOnly: sqlReadMode,
      }
    );
    timing.session_check_ms = Date.now() - sessionCheckStartedAt;
    if (!sessionValidation.ok) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: sessionValidation.response, timing };
    }

    return finishPlayerLiveAuth(
      appSessionAuth.uid,
      sessionValidation.sessionSource === 'sql'
        ? 'app_session_sql_session_sql'
        : 'app_session_sql_session_firestore',
      sessionValidation.sessionSource
    );
  }

  const token = bearerToken(request);
  if (!token) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Missing or invalid authorization.', 401), timing };
  }

  const verifyStartedAt = Date.now();
  let identityUid = '';
  try {
    const verified = await verifyLiveCarerApiToken(token);
    identityUid = verified.uid;
    timing.token_cache_hit = verified.cacheHit;
  } catch {
    timing.verify_token_ms = Date.now() - verifyStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Invalid or expired authorization token.', 401), timing };
  }
  timing.verify_token_ms = Date.now() - verifyStartedAt;

  if (identityUid !== expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  if (!sessionId) {
    console.info('[API_AUTH] player request blocked', {
      uid: identityUid,
      reason: 'missing_session_header',
      sessionId: null,
      activeSessionId: null,
    });
    timing.auth_ms = Date.now() - authStartedAt;
    return {
      ok: false,
      response: apiError('X-Player-Session-Id header is required.', 401),
      timing,
    };
  }

  const sqlProfileStartedAt = Date.now();
  const sqlProfileLookup = await lookupPlayerProfileFromSqlCache(identityUid);
  timing.sql_profile_ms = Date.now() - sqlProfileStartedAt;
  timing.sql_profile_pool_acquire_ms = sqlProfileLookup.timing.pool_acquire_ms;
  timing.sql_profile_query_exec_ms = sqlProfileLookup.timing.query_exec_ms;
  timing.sql_profile_total_ms = sqlProfileLookup.timing.total_ms;

  if (sqlReadMode) {
    if (!sqlProfileLookup.profile || sqlProfileLookup.missReason) {
      const reason = sqlProfileLookup.missReason || 'row_missing';
      console.info('[LIVE_AUTH_PLAYER_SQL] blocked uid=%s reason=%s', identityUid, reason);
      timing.auth_ms = Date.now() - authStartedAt;
      if (reason === 'postgres_unavailable') {
        return {
          ok: false,
          response: apiError('SQL auth is unavailable. Configure DATABASE_URL on the server.', 503),
          timing,
        };
      }
      return {
        ok: false,
        response: apiError(
          'User profile not found in SQL cache. Ensure players_cache is populated for this user.',
          404
        ),
        timing,
      };
    }

    if (sqlProfileLookup.profile.role !== 'player') {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('Forbidden.', 403), timing };
    }

    const sessionCheckStartedAt = Date.now();
    const sessionValidation = await validatePlayerApiSession(identityUid, sessionId, timing, {
      appSessionId,
      sqlOnly: true,
    });
    timing.session_check_ms = Date.now() - sessionCheckStartedAt;
    if (!sessionValidation.ok) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: sessionValidation.response, timing };
    }

    return finishPlayerLiveAuth(
      identityUid,
      sessionValidation.sessionSource === 'sql'
        ? 'player_token_sql_session_sql'
        : 'player_token_sql_session_firestore',
      sessionValidation.sessionSource
    );
  }

  const usedSqlProfile = sqlProfileLookup.profile?.role === 'player';
  const sqlActiveSessionId = usedSqlProfile
    ? String(sqlProfileLookup.profile?.activeSessionId || '').trim()
    : '';

  if (!usedSqlProfile) {
    if (sqlProfileLookup.profile && sqlProfileLookup.profile.role !== 'player') {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('Forbidden.', 403), timing };
    }

    if (sqlProfileLookup.missReason) {
      console.info('[LIVE_AUTH_PLAYER_FALLBACK] reason=%s uid=%s', sqlProfileLookup.missReason, identityUid);
    }

    const userDocStartedAt = Date.now();
    const userSnap = await adminDb.collection('users').doc(identityUid).get();
    timing.user_doc_ms = Date.now() - userDocStartedAt;

    if (!userSnap.exists) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('User profile not found.', 401), timing };
    }

    const data = userSnap.data() || {};
    const role = String(data.role || '').toLowerCase() as ApiRole;
    if (role !== 'player') {
      timing.auth_ms = Date.now() - authStartedAt;
      return { ok: false, response: apiError('Forbidden.', 403), timing };
    }

    try {
      await mirrorPlayerById(identityUid, 'player_live_auth_hydrate');
    } catch (error) {
      console.info('[LIVE_AUTH_PLAYER_FALLBACK] hydrate_failed uid=%s error=%s', identityUid, error);
    }
  }

  const sessionCheckStartedAt = Date.now();
  const sessionValidation = await validatePlayerApiSession(identityUid, sessionId, timing, {
    appSessionId,
    sqlOnly: sqlReadMode,
  });
  timing.session_check_ms = Date.now() - sessionCheckStartedAt;

  if (!sessionValidation.ok) {
    timing.auth_path = resolvePlayerLiveAuthPath(usedSqlProfile, timing.session_source);
    logPlayerLiveAuthBlocked(identityUid, 'session_validation_failed', {
      activeSessionId: sqlActiveSessionId || null,
    });
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: sessionValidation.response, timing };
  }

  return finishPlayerLiveAuth(
    identityUid,
    resolvePlayerLiveAuthPath(usedSqlProfile, sessionValidation.sessionSource),
    sessionValidation.sessionSource,
    sessionId
  );
}

export type CarerLiveAuthTiming = {
  auth_path: 'carer_app_session_sql' | 'carer_token_sql' | 'carer_token_firestore';
  auth_ms: number;
  verify_token_ms: number;
  sql_profile_ms: number;
  /** @deprecated Use sql_profile_total_ms */
  sql_profile_query_ms: number;
  sql_profile_pool_acquire_ms: number;
  sql_profile_query_exec_ms: number;
  sql_profile_total_ms: number;
  user_doc_ms: number;
  token_cache_hit: boolean;
};

export async function requireCarerOwnedLiveAuth(
  request: Request,
  expectedCarerUid: string,
  options?: { mirrorClient?: PoolClient }
): Promise<
  | { ok: true; uid: string; coadminUid: string | null; timing: CarerLiveAuthTiming }
  | { ok: false; response: NextResponse; timing: CarerLiveAuthTiming }
> {
  const authStartedAt = Date.now();
  const expectedUid = String(expectedCarerUid || '').trim();
  const timing: CarerLiveAuthTiming = {
    auth_path: 'carer_token_firestore',
    auth_ms: 0,
    verify_token_ms: 0,
    sql_profile_ms: 0,
    sql_profile_query_ms: 0,
    sql_profile_pool_acquire_ms: 0,
    sql_profile_query_exec_ms: 0,
    sql_profile_total_ms: 0,
    user_doc_ms: 0,
    token_cache_hit: false,
  };

  if (!expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  if (appSessionIdFromRequest(request)) {
    const appSessionAuth = await verifyAppSessionFromRequest(request, options);
    if (
      appSessionAuth.hit &&
      appSessionAuth.role === 'carer' &&
      appSessionAuth.uid === expectedUid
    ) {
      timing.auth_path = 'carer_app_session_sql';
      timing.sql_profile_ms = appSessionAuth.profileMs;
      timing.auth_ms = Date.now() - authStartedAt;
      return {
        ok: true,
        uid: expectedUid,
        coadminUid: appSessionAuth.coadminUid,
        timing,
      };
    }
  }

  const token = bearerToken(request);
  if (!token) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Missing or invalid authorization.', 401), timing };
  }

  const verifyStartedAt = Date.now();
  let identityUid = '';
  try {
    const verified = await verifyLiveCarerApiToken(token);
    identityUid = verified.uid;
    timing.token_cache_hit = verified.cacheHit;
  } catch {
    timing.verify_token_ms = Date.now() - verifyStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Invalid or expired authorization token.', 401), timing };
  }
  timing.verify_token_ms = Date.now() - verifyStartedAt;

  if (identityUid !== expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const sqlProfileStartedAt = Date.now();
  const sqlProfileLookup = await lookupCarerProfileFromSqlCache(identityUid, options?.mirrorClient);
  timing.sql_profile_ms = Date.now() - sqlProfileStartedAt;
  timing.sql_profile_query_ms = sqlProfileLookup.timing.total_ms;
  timing.sql_profile_pool_acquire_ms = sqlProfileLookup.timing.pool_acquire_ms;
  timing.sql_profile_query_exec_ms = sqlProfileLookup.timing.query_exec_ms;
  timing.sql_profile_total_ms = sqlProfileLookup.timing.total_ms;

  if (sqlProfileLookup.profile?.role === 'carer') {
    timing.auth_path = 'carer_token_sql';
    timing.auth_ms = Date.now() - authStartedAt;
    return {
      ok: true,
      uid: identityUid,
      coadminUid: sqlProfileLookup.profile.coadminUid,
      timing,
    };
  }

  const userDocStartedAt = Date.now();
  const userSnap = await adminDb.collection('users').doc(identityUid).get();
  timing.user_doc_ms = Date.now() - userDocStartedAt;

  if (!userSnap.exists) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('User profile not found.', 401), timing };
  }

  const data = userSnap.data() || {};
  const role = String(data.role || '').toLowerCase() as ApiRole;
  if (role !== 'carer') {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const coadminUid =
    String(data.coadminUid || data.createdBy || '').trim() || null;
  try {
    await mirrorPlayerById(identityUid, 'carer_live_auth_hydrate');
    console.info('[LIVE_AUTH_SQL_PROFILE] hydrate uid=%s coadminUid=%s', identityUid, coadminUid);
  } catch (error) {
    console.info('[LIVE_AUTH_SQL_PROFILE] hydrate_failed uid=%s', identityUid, error);
  }

  timing.auth_path = 'carer_token_firestore';
  timing.auth_ms = Date.now() - authStartedAt;
  return {
    ok: true,
    uid: identityUid,
    coadminUid,
    timing,
  };
}

export function apiUserAuthSqlMs(timing: ApiUserAuthTiming) {
  return timing.sql_profile_ms + timing.sql_session_ms;
}

export function apiUserAuthFirestoreMs(timing: ApiUserAuthTiming) {
  return timing.session_doc_ms + timing.user_doc_ms;
}

export async function requireApiUser(
  request: Request,
  allowedRoles: ApiRole[],
  options?: { rechargeFirestoreInstrumentation?: boolean }
): Promise<
  | { user: ApiUser; authPath: ApiUserAuthPath; timing: ApiUserAuthTiming }
  | { response: NextResponse; timing: ApiUserAuthTiming }
> {
  const authStartedAt = Date.now();
  const timing: ApiUserAuthTiming = {
    auth_path: 'api_user_firestore',
    verify_token_ms: 0,
    sql_profile_ms: 0,
    sql_session_ms: 0,
    user_doc_ms: 0,
    session_doc_ms: 0,
    session_source: 'none',
    auth_ms: 0,
    token_cache_hit: false,
  };

  const appSessionAuthResult = await authenticateApiUserFromAppSession(
    request,
    allowedRoles,
    timing,
    options
  );
  if (appSessionAuthResult) {
    if ('response' in appSessionAuthResult) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: appSessionAuthResult.response, timing };
    }
    timing.auth_ms = Date.now() - authStartedAt;
    console.info('[API_AUTH] request allowed', {
      uid: appSessionAuthResult.user.uid,
      role: appSessionAuthResult.user.role,
      auth_path: appSessionAuthResult.authPath,
      session_source: timing.session_source,
      token_cache_hit: false,
      verify_token_ms: 0,
      sql_profile_ms: timing.sql_profile_ms,
      sql_session_ms: timing.sql_session_ms,
      user_doc_ms: 0,
      session_doc_ms: timing.session_doc_ms,
      auth_ms: timing.auth_ms,
    });
    return {
      user: appSessionAuthResult.user,
      authPath: appSessionAuthResult.authPath,
      timing,
    };
  }

  const token = bearerToken(request);
  if (!token) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { response: apiError('Missing or invalid authorization.', 401), timing };
  }

  const verifyStartedAt = Date.now();
  let identityUid = '';
  try {
    const verified = await verifyLiveCarerApiToken(token);
    identityUid = verified.uid;
    timing.token_cache_hit = verified.cacheHit;
  } catch {
    timing.verify_token_ms = Date.now() - verifyStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { response: apiError('Invalid or expired authorization token.', 401), timing };
  }
  timing.verify_token_ms = Date.now() - verifyStartedAt;

  const sqlProfileStartedAt = Date.now();
  const sqlProfileLookup = await lookupApiUserProfileFromSqlCache(identityUid);
  timing.sql_profile_ms = Date.now() - sqlProfileStartedAt;

  let user: ApiUser | null = null;
  let usedSqlProfile = false;
  let activeSessionId = '';

  if (sqlProfileLookup.profile) {
    const role = sqlProfileLookup.profile.role as ApiRole;
    if (!allowedRoles.includes(role)) {
      timing.auth_ms = Date.now() - authStartedAt;
      console.info('[API_AUTH] request blocked', {
        uid: identityUid,
        role,
        allowedRoles,
        auth_path: timing.auth_path,
        reason: 'role_not_allowed',
      });
      return { response: apiError('Forbidden.', 403), timing };
    }

    if (role === 'player') {
      const sessionId = playerSessionId(request);
      activeSessionId = String(sqlProfileLookup.profile.activeSessionId || '').trim();
      if (sessionId && activeSessionId && sessionId === activeSessionId) {
        usedSqlProfile = true;
        user = apiUserFromSqlProfile(sqlProfileLookup.profile);
        timing.auth_path = 'api_user_sql';
      } else {
        console.info(
          '[API_AUTH_FIRESTORE_FALLBACK] reason=%s uid=%s sessionId=%s sqlActiveSessionId=%s context=api_user_profile',
          !sessionId
            ? 'missing_session_header'
            : !activeSessionId
              ? 'missing_sql_active_session_id'
              : 'session_mismatch',
          identityUid,
          sessionId || null,
          activeSessionId || null
        );
      }
    } else {
      usedSqlProfile = true;
      user = apiUserFromSqlProfile(sqlProfileLookup.profile);
      timing.auth_path = 'api_user_sql';
    }
  } else if (sqlProfileLookup.missReason) {
    console.info(
      '[API_AUTH_FIRESTORE_FALLBACK] reason=%s uid=%s context=api_user_profile',
      sqlProfileLookup.missReason,
      identityUid
    );
  }

  if (!usedSqlProfile) {
    const userDocStartedAt = Date.now();
    const snap = await adminDb.collection('users').doc(identityUid).get();
    timing.user_doc_ms = Date.now() - userDocStartedAt;

    if (!snap.exists) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: apiError('User profile not found.', 401), timing };
    }

    const data = snap.data() || {};
    const role = String(data.role || '').toLowerCase() as ApiRole;
    if (!allowedRoles.includes(role)) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: apiError('Forbidden.', 403), timing };
    }

    user = apiUserFromFirestore(identityUid, data);
    activeSessionId = String(data.activeSessionId || '').trim();
    timing.auth_path = 'api_user_firestore';

    try {
      await mirrorPlayerById(identityUid, 'api_user_auth_hydrate');
    } catch (error) {
      console.info(
        '[API_AUTH_FIRESTORE_FALLBACK] reason=hydrate_failed uid=%s error=%s context=api_user_profile',
        identityUid,
        error
      );
    }
  }

  if (!user) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { response: apiError('User profile not found.', 401), timing };
  }

  if (user.role === 'player') {
    const sessionId = playerSessionId(request);
    if (!sessionId || sessionId !== activeSessionId) {
      console.info('[API_AUTH] player request blocked', {
        uid: identityUid,
        reason: !sessionId
          ? 'missing_session_header'
          : !activeSessionId
            ? 'missing_active_session_id'
            : 'session_mismatch',
        sessionId: sessionId || null,
        activeSessionId: activeSessionId || null,
        auth_path: timing.auth_path,
      });
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: playerSessionBlockedResponse(), timing };
    }

    const sessionValidation = await validatePlayerApiSession(identityUid, sessionId, timing, {
      appSessionId: appSessionIdFromRequest(request),
    });
    if (!sessionValidation.ok) {
      timing.auth_ms = Date.now() - authStartedAt;
      return { response: sessionValidation.response, timing };
    }

    if (usedSqlProfile && sessionValidation.sessionSource === 'sql') {
      timing.auth_path = 'api_user_sql_session_sql';
    } else if (usedSqlProfile) {
      timing.auth_path = 'api_user_sql_session_firestore';
    }

    console.info('[API_AUTH] player request allowed', {
      uid: identityUid,
      sessionId,
      reason: 'session_match',
      auth_path: timing.auth_path,
      session_source: timing.session_source,
    });
  }

  timing.auth_ms = Date.now() - authStartedAt;
  console.info('[API_AUTH] request allowed', {
    uid: user.uid,
    role: user.role,
    auth_path: timing.auth_path,
    session_source: timing.session_source,
    token_cache_hit: timing.token_cache_hit,
    verify_token_ms: timing.verify_token_ms,
    sql_profile_ms: timing.sql_profile_ms,
    sql_session_ms: timing.sql_session_ms,
    user_doc_ms: timing.user_doc_ms,
    session_doc_ms: timing.session_doc_ms,
    auth_ms: timing.auth_ms,
  });

  return { user, authPath: timing.auth_path, timing };
}

export function scopedCoadminUid(user: ApiUser) {
  if (user.role === 'coadmin') {
    return user.uid;
  }
  return user.coadminUid || user.createdBy || null;
}

export function belongsToScope(
  target: { coadminUid?: unknown; createdBy?: unknown },
  coadminUid: string
) {
  return (
    String(target.coadminUid || '').trim() === coadminUid ||
    String(target.createdBy || '').trim() === coadminUid
  );
}
