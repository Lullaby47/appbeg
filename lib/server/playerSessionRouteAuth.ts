import 'server-only';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, verifyAppSessionFromRequest } from '@/lib/firebase/apiAuth';
import { verifyLiveCarerApiToken } from '@/lib/firebase/liveAuthTokenCache';
import {
  authSqlEnvErrorResponse,
  authSqlProfileErrorResponse,
  logAuthSqlRouteStart,
} from '@/lib/server/authSqlReadErrors';
import {
  authSqlReadEnvLogFields,
  isAuthSqlReadEnabled,
} from '@/lib/server/authSqlRead';
import {
  isAppbegSqlOnlyMode,
  isAuthFirestoreFallbackAllowed,
  logFirebaseAuthFallbackDisabled,
  logSqlAuthNoFirestore,
  logSqlAuthProfileRead,
  shouldAuthUseSqlOnly,
} from '@/lib/server/appbegSqlOnlyMode';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  lookupApiUserProfileFromSqlCache,
  mirrorPlayerById,
} from '@/lib/sql/playersCache';

function bearerToken(request: Request) {
  return (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1] || '';
}

export async function requireFirebasePlayerUser(request: Request) {
  const token = bearerToken(request);
  if (!token) {
    return { response: apiError('Missing or invalid authorization.', 401) } as const;
  }

  let uid = '';
  try {
    const verified = await verifyLiveCarerApiToken(token);
    uid = verified.uid;
  } catch {
    return { response: apiError('Invalid or expired authorization token.', 401) } as const;
  }

  const sqlReadMode = shouldAuthUseSqlOnly();
  logAuthSqlRouteStart('requireFirebasePlayerUser', {
    uid,
    ...authSqlReadEnvLogFields(),
  });
  logSqlAuthNoFirestore('requireFirebasePlayerUser', { uid, token_only: true });

  if (sqlReadMode) {
    const env = authSqlReadEnvLogFields();
    if (!env.database_url_configured) {
      return { response: authSqlEnvErrorResponse({ route: 'player_session_route_auth' }) } as const;
    }

    const profileLookup = await lookupApiUserProfileFromSqlCache(uid);
    logSqlAuthProfileRead({
      uid,
      role: profileLookup.profile?.role ?? null,
      source: 'sql',
      missReason: profileLookup.missReason,
      route: 'requireFirebasePlayerUser',
    });
    if (!profileLookup.profile) {
      return {
        response: authSqlProfileErrorResponse(profileLookup, {
          route: 'player_session_route_auth',
        }),
      } as const;
    }

    if (profileLookup.profile.role !== 'player') {
      return { response: apiError('Forbidden.', 403) } as const;
    }

    return {
      uid,
      username: profileLookup.profile.username,
      profile: profileLookup.profile,
    } as const;
  }

  let profileLookup = await lookupApiUserProfileFromSqlCache(uid);
  if (!profileLookup.profile && !isAppbegSqlOnlyMode()) {
    try {
      await mirrorPlayerById(uid, 'player_session_route_hydrate');
    } catch {
      // Best-effort hydrate before retry.
    }
    profileLookup = await lookupApiUserProfileFromSqlCache(uid);
  }

  if (profileLookup.profile?.role === 'player') {
    logSqlAuthProfileRead({
      uid,
      role: 'player',
      source: 'sql',
      route: 'requireFirebasePlayerUser',
    });
    return {
      uid,
      username: profileLookup.profile.username,
      profile: profileLookup.profile,
    } as const;
  }

  if (!isAuthFirestoreFallbackAllowed()) {
    logFirebaseAuthFallbackDisabled('requireFirebasePlayerUser', 'auth_firestore_fallback_disabled', {
      uid,
      miss_reason: profileLookup.missReason || 'row_missing',
    });
    return {
      response: apiError(
        'User profile not found in SQL cache. Ensure players_cache is populated for this user.',
        404
      ),
    } as const;
  }

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: 'lib/server/playerSessionRouteAuth.requireFirebasePlayerUser',
    operation: 'read',
    collection: 'users',
    document_id: uid,
    sql_read_mode: isAuthSqlReadEnabled(),
  });
  const userSnap = await adminDb.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    return { response: apiError('User profile not found.', 401) } as const;
  }

  const data = userSnap.data() || {};
  const role = cleanText(data.role).toLowerCase();
  if (role !== 'player') {
    return { response: apiError('Forbidden.', 403) } as const;
  }

  return {
    uid,
    username: cleanText(data.username),
    profile: null,
  } as const;
}

export async function requirePlayerSessionActor(request: Request) {
  const appSession = await verifyAppSessionFromRequest(request);
  if (appSession.hit && appSession.profile.role === 'player') {
    logSqlAuthNoFirestore('requirePlayerSessionActor', {
      uid: appSession.uid,
      auth_path: 'app_session_sql',
    });
    return {
      uid: appSession.uid,
      username: appSession.profile.username,
      profile: appSession.profile,
      authPath: 'app_session_sql' as const,
    } as const;
  }

  const firebaseAuth = await requireFirebasePlayerUser(request);
  if ('response' in firebaseAuth) {
    return firebaseAuth;
  }

  return {
    ...firebaseAuth,
    authPath: 'firebase_bearer' as const,
  } as const;
}
