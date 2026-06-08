import 'server-only';

import { adminDb } from '@/lib/firebase/admin';
import { verifyAppSessionFromRequest } from '@/lib/firebase/apiAuth';
import {
  buildPlayerSessionAuthCacheKey,
  getCachedPlayerSessionStatusEntry,
  invalidatePlayerSessionAuthCache,
  writePlayerSessionAuthCache,
  type PlayerSessionStatusResult,
} from '@/lib/server/playerSessionAuthCache';
import { requireFirebasePlayerUser } from '@/lib/server/playerSessionRouteAuth';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  lookupApiUserProfileFromSqlCache,
  mirrorPlayerById,
  type ApiUserSqlProfileLookup,
} from '@/lib/sql/playersCache';
import { lookupPlayerSessionFromSqlCache } from '@/lib/sql/playerSessionsCache';

export type {
  PlayerSessionStatusReason,
  PlayerSessionStatusResult,
} from '@/lib/server/playerSessionAuthCache';

export {
  getCachedPlayerSessionValidation,
  invalidatePlayerSessionAuthCache,
} from '@/lib/server/playerSessionAuthCache';

export const invalidatePlayerSessionStatusCache = invalidatePlayerSessionAuthCache;

function playerSessionIdFromRequest(request: Request) {
  return cleanText(request.headers.get('X-Player-Session-Id'));
}

function appSessionIdFromRequest(request: Request) {
  return cleanText(request.headers.get('X-App-Session-Id'));
}

async function resolvePlayerUidFromRequest(request: Request) {
  const appSession = await verifyAppSessionFromRequest(request);
  if (appSession.hit && appSession.profile.role === 'player') {
    return {
      uid: appSession.uid,
      authPath: 'app_session_sql' as const,
      profile: appSession.profile,
      appSessionId: appSession.sessionId,
    };
  }

  const auth = await requireFirebasePlayerUser(request);
  if ('response' in auth) {
    return auth;
  }

  return {
    uid: auth.uid,
    authPath: 'firebase_bearer' as const,
    profile: auth.profile,
    appSessionId: appSessionIdFromRequest(request),
  };
}

async function readPlayerSessionStatusFromSql(
  uid: string,
  sessionId: string,
  knownProfile?: ApiUserSqlProfileLookup | null
) {
  let profile = knownProfile || null;

  if (!profile) {
    let profileLookup = await lookupApiUserProfileFromSqlCache(uid);
    if (!profileLookup.profile) {
      try {
        await mirrorPlayerById(uid, 'player_session_status_hydrate');
      } catch {
        // Best-effort hydrate.
      }
      profileLookup = await lookupApiUserProfileFromSqlCache(uid);
    }

    if (
      profileLookup.missReason === 'postgres_unavailable' ||
      profileLookup.missReason === 'lookup_failed'
    ) {
      return { available: false as const };
    }

    if (!profileLookup.profile || profileLookup.profile.role !== 'player') {
      return { available: true as const, incomplete: true as const };
    }

    profile = profileLookup.profile;
  }

  const activeSessionId = cleanText(profile.activeSessionId);
  if (!activeSessionId || activeSessionId !== sessionId) {
    return {
      available: true as const,
      result: {
        ok: false,
        reason: 'session_replaced' as const,
        uid,
        activeSessionId: activeSessionId || null,
        sessionId,
        replaced: true,
        source: 'sql' as const,
      } satisfies PlayerSessionStatusResult,
    };
  }

  const sessionLookup = await lookupPlayerSessionFromSqlCache(sessionId, uid);
  if (
    sessionLookup.missReason === 'postgres_unavailable' ||
    sessionLookup.missReason === 'lookup_failed'
  ) {
    return { available: false as const };
  }

  if (
    sessionLookup.missReason === 'inactive' ||
    sessionLookup.missReason === 'expired' ||
    sessionLookup.missReason === 'player_mismatch'
  ) {
    return {
      available: true as const,
      result: {
        ok: false,
        reason: 'session_inactive' as const,
        uid,
        activeSessionId,
        sessionId,
        source: 'sql' as const,
      } satisfies PlayerSessionStatusResult,
    };
  }

  if (sessionLookup.missReason === 'row_missing') {
    return { available: true as const, incomplete: true as const };
  }

  return {
    available: true as const,
    result: {
      ok: true,
      active: true,
      uid,
      activeSessionId,
      sessionId,
      replaced: false,
      source: 'sql' as const,
    } satisfies PlayerSessionStatusResult,
  };
}

async function readPlayerSessionStatusFromFirestore(uid: string, sessionId: string) {
  const userSnap = await adminDb.collection('users').doc(uid).get();
  const activeSessionId = cleanText(userSnap.data()?.activeSessionId);
  if (!activeSessionId || activeSessionId !== sessionId) {
    return {
      ok: false,
      reason: 'session_replaced' as const,
      uid,
      activeSessionId: activeSessionId || null,
      sessionId,
      replaced: true,
      source: 'firestore_fallback' as const,
    } satisfies PlayerSessionStatusResult;
  }

  const sessionSnap = await adminDb.collection('playerSessions').doc(sessionId).get();
  const sessionData = sessionSnap.data() || {};
  if (
    !sessionSnap.exists ||
    cleanText(sessionData.playerUid) !== uid ||
    sessionData.active !== true
  ) {
    return {
      ok: false,
      reason: 'session_inactive' as const,
      uid,
      activeSessionId,
      sessionId,
      source: 'firestore_fallback' as const,
    } satisfies PlayerSessionStatusResult;
  }

  return {
    ok: true,
    active: true,
    uid,
    activeSessionId,
    sessionId,
    replaced: false,
    source: 'firestore_fallback' as const,
  } satisfies PlayerSessionStatusResult;
}

export async function resolvePlayerSessionStatus(request: Request) {
  const startedAt = Date.now();
  const sessionId = playerSessionIdFromRequest(request);
  if (!sessionId) {
    const result: PlayerSessionStatusResult = {
      ok: false,
      reason: 'missing_session_header',
      sessionId: null,
    };
    console.info('[PLAYER_SESSION_STATUS]', {
      source: 'sql',
      uid: '',
      sessionId: '',
      activeSessionId: '',
      ok: false,
      reason: result.reason,
      durationMs: Date.now() - startedAt,
    });
    return { status: 400, result };
  }

  const auth = await resolvePlayerUidFromRequest(request);
  if ('response' in auth) {
    const result: PlayerSessionStatusResult = {
      ok: false,
      reason: 'unauthorized',
      sessionId,
    };
    console.info('[PLAYER_SESSION_STATUS]', {
      source: 'sql',
      uid: '',
      sessionId,
      activeSessionId: '',
      ok: false,
      reason: result.reason,
      durationMs: Date.now() - startedAt,
    });
    return { status: 401, result };
  }

  const uid = auth.uid;
  const appSessionId =
    'appSessionId' in auth && auth.appSessionId
      ? auth.appSessionId
      : appSessionIdFromRequest(request);
  const cachedEntry = getCachedPlayerSessionStatusEntry({
    appSessionId,
    playerSessionId: sessionId,
    uid,
  });
  if (cachedEntry) {
    const now = Date.now();
    const cached = cachedEntry.result;
    console.info('[PLAYER_SESSION_STATUS_CACHE]', {
      hit: true,
      uid,
      sessionId,
      cacheKey: cachedEntry.cacheKey,
      ok: cached.ok,
      reason: cached.reason || null,
      ageMs: now - cachedEntry.cachedAt,
      expiresInMs: cachedEntry.expiresAt - now,
      durationMs: now - startedAt,
    });
    console.info('[PLAYER_SESSION_STATUS]', {
      source: cached.source || 'sql',
      uid,
      sessionId,
      activeSessionId: cached.activeSessionId || '',
      ok: cached.ok,
      reason: cached.reason || null,
      durationMs: now - startedAt,
      cache_hit: true,
    });
    return { status: 200, result: cached };
  }

  console.info('[PLAYER_SESSION_STATUS_CACHE]', {
    hit: false,
    uid,
    sessionId,
    appSessionId: appSessionId || null,
    cacheKey: buildPlayerSessionAuthCacheKey(appSessionId, sessionId, uid),
    durationMs: Date.now() - startedAt,
  });

  try {
    const sqlStatus = await readPlayerSessionStatusFromSql(
      uid,
      sessionId,
      auth.profile || null
    );
    if (sqlStatus.available && sqlStatus.result) {
      writePlayerSessionAuthCache(
        { appSessionId, playerSessionId: sessionId, uid },
        sqlStatus.result,
        { reason: 'status_sql_success' }
      );
      console.info('[PLAYER_SESSION_STATUS]', {
        source: sqlStatus.result.source || 'sql',
        uid,
        sessionId,
        activeSessionId: sqlStatus.result.activeSessionId || '',
        ok: sqlStatus.result.ok,
        reason: sqlStatus.result.reason || null,
        durationMs: Date.now() - startedAt,
        cache_hit: false,
      });
      return { status: 200, result: sqlStatus.result };
    }
  } catch (error) {
    console.warn('[PLAYER_SESSION_STATUS] sql read failed', {
      uid,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const result = await readPlayerSessionStatusFromFirestore(uid, sessionId);
  writePlayerSessionAuthCache(
    { appSessionId, playerSessionId: sessionId, uid },
    result,
    { reason: 'status_firestore_success' }
  );
  console.info('[PLAYER_SESSION_STATUS]', {
    source: result.source || 'firestore_fallback',
    uid,
    sessionId,
    activeSessionId: result.activeSessionId || '',
    ok: result.ok,
    reason: result.reason || null,
    durationMs: Date.now() - startedAt,
    cache_hit: false,
  });
  return { status: 200, result };
}
