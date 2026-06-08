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

  const sqlReadMode = isAuthSqlReadEnabled();
  logAuthSqlRouteStart('requireFirebasePlayerUser', {
    uid,
    ...authSqlReadEnvLogFields(),
  });

  if (sqlReadMode) {
    const env = authSqlReadEnvLogFields();
    if (!env.database_url_configured) {
      return { response: authSqlEnvErrorResponse({ route: 'player_session_route_auth' }) } as const;
    }

    const profileLookup = await lookupApiUserProfileFromSqlCache(uid);
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
  if (!profileLookup.profile) {
    try {
      await mirrorPlayerById(uid, 'player_session_route_hydrate');
    } catch {
      // Best-effort hydrate before retry.
    }
    profileLookup = await lookupApiUserProfileFromSqlCache(uid);
  }

  if (profileLookup.profile?.role === 'player') {
    return {
      uid,
      username: profileLookup.profile.username,
      profile: profileLookup.profile,
    } as const;
  }

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
