import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { verifyLiveCarerApiToken } from '@/lib/firebase/liveAuthTokenCache';
import {
  lookupCarerProfileFromSqlCache,
  mirrorPlayerById,
} from '@/lib/sql/playersCache';

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

export type PlayerLiveAuthTiming = {
  auth_path: 'player_token_session';
  verify_token_ms: number;
  user_doc_ms: number;
  session_check_ms: number;
  auth_ms: number;
};

function playerSessionBlockedResponse() {
  return apiError(
    'You were logged out because this account logged in on another device.',
    401
  );
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
  const timing: PlayerLiveAuthTiming = {
    auth_path: 'player_token_session',
    verify_token_ms: 0,
    user_doc_ms: 0,
    session_check_ms: 0,
    auth_ms: 0,
  };

  if (!expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const verifyStartedAt = Date.now();
  const identity = await verifyApiTokenIdentity(request);
  timing.verify_token_ms = Date.now() - verifyStartedAt;
  if ('response' in identity) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: identity.response, timing };
  }

  if (identity.uid !== expectedUid) {
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const sessionId = playerSessionId(request);
  if (!sessionId) {
    console.info('[API_AUTH] player request blocked', {
      uid: identity.uid,
      reason: 'missing_session_header',
      sessionId: null,
      activeSessionId: null,
    });
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: playerSessionBlockedResponse(), timing };
  }

  const fetchStartedAt = Date.now();
  const [userSnap, sessionSnap] = await Promise.all([
    adminDb.collection('users').doc(identity.uid).get(),
    adminDb.collection('playerSessions').doc(sessionId).get(),
  ]);
  timing.user_doc_ms = Date.now() - fetchStartedAt;

  const sessionCheckStartedAt = Date.now();
  if (!userSnap.exists) {
    timing.session_check_ms = Date.now() - sessionCheckStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('User profile not found.', 401), timing };
  }

  const data = userSnap.data() || {};
  const role = String(data.role || '').toLowerCase() as ApiRole;
  if (role !== 'player') {
    timing.session_check_ms = Date.now() - sessionCheckStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: apiError('Forbidden.', 403), timing };
  }

  const activeSessionId = String(data.activeSessionId || '').trim();
  if (sessionId !== activeSessionId) {
    console.info('[API_AUTH] player request blocked', {
      uid: identity.uid,
      reason: !activeSessionId ? 'missing_active_session_id' : 'session_mismatch',
      sessionId,
      activeSessionId: activeSessionId || null,
    });
    timing.session_check_ms = Date.now() - sessionCheckStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: playerSessionBlockedResponse(), timing };
  }

  const sessionData = sessionSnap.data() || {};
  if (
    !sessionSnap.exists ||
    String(sessionData.playerUid || '') !== identity.uid ||
    sessionData.active !== true
  ) {
    console.info('[API_AUTH] player request blocked', {
      uid: identity.uid,
      reason: !sessionSnap.exists
        ? 'session_doc_missing'
        : String(sessionData.playerUid || '') !== identity.uid
          ? 'session_uid_mismatch'
          : 'session_doc_inactive',
      sessionId,
      activeSessionId,
    });
    timing.session_check_ms = Date.now() - sessionCheckStartedAt;
    timing.auth_ms = Date.now() - authStartedAt;
    return { ok: false, response: playerSessionBlockedResponse(), timing };
  }

  console.info('[API_AUTH] player request allowed', {
    uid: identity.uid,
    sessionId,
    reason: 'session_match',
  });

  timing.session_check_ms = Date.now() - sessionCheckStartedAt;
  timing.auth_ms = Date.now() - authStartedAt;
  return { ok: true, uid: identity.uid, timing };
}

export type CarerLiveAuthTiming = {
  auth_path: 'carer_token_sql' | 'carer_token_firestore';
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

export async function requireApiUser(
  request: Request,
  allowedRoles: ApiRole[]
): Promise<{ user: ApiUser } | { response: NextResponse }> {
  const token = bearerToken(request);
  if (!token) {
    return { response: apiError('Missing or invalid authorization.', 401) };
  }

  let decoded: { uid: string };
  try {
    decoded = await adminAuth.verifyIdToken(token);
  } catch {
    return { response: apiError('Invalid or expired authorization token.', 401) };
  }
  const snap = await adminDb.collection('users').doc(decoded.uid).get();
  if (!snap.exists) {
    return { response: apiError('User profile not found.', 401) };
  }

  const data = snap.data() || {};
  const role = String(data.role || '').toLowerCase() as ApiRole;
  if (!allowedRoles.includes(role)) {
    return { response: apiError('Forbidden.', 403) };
  }

  if (role === 'player') {
    const sessionId = playerSessionId(request);
    const activeSessionId = String(data.activeSessionId || '').trim();
    if (!sessionId || sessionId !== activeSessionId) {
      console.info('[API_AUTH] player request blocked', {
        uid: decoded.uid,
        reason: !sessionId
          ? 'missing_session_header'
          : !activeSessionId
            ? 'missing_active_session_id'
            : 'session_mismatch',
        sessionId: sessionId || null,
        activeSessionId: activeSessionId || null,
      });
      return {
        response: apiError(
          'You were logged out because this account logged in on another device.',
          401
        ),
      };
    }

    const sessionSnap = await adminDb.collection('playerSessions').doc(sessionId).get();
    const sessionData = sessionSnap.data() || {};
    if (
      !sessionSnap.exists ||
      String(sessionData.playerUid || '') !== decoded.uid ||
      sessionData.active !== true
    ) {
      console.info('[API_AUTH] player request blocked', {
        uid: decoded.uid,
        reason: !sessionSnap.exists
          ? 'session_doc_missing'
          : String(sessionData.playerUid || '') !== decoded.uid
            ? 'session_uid_mismatch'
            : 'session_doc_inactive',
        sessionId,
        activeSessionId,
      });
      return {
        response: apiError(
          'You were logged out because this account logged in on another device.',
          401
        ),
      };
    }

    console.info('[API_AUTH] player request allowed', {
      uid: decoded.uid,
      sessionId,
      reason: 'session_match',
    });
  }

  return {
    user: {
      uid: decoded.uid,
      role,
      username: String(data.username || ''),
      coadminUid: String(data.coadminUid || data.createdBy || '').trim() || null,
      createdBy: String(data.createdBy || '').trim() || null,
      automationAgentId: String(data.automationAgentId || '').trim() || null,
    },
  };
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
