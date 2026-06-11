import { NextResponse } from 'next/server';



import { verifyAppSessionFromRequest } from '@/lib/firebase/apiAuth';
import { logSqlAuthNoFirestore, logSqlAuthProfileRead, logSqlAuthSessionRead } from '@/lib/server/appbegSqlOnlyMode';
import { readSessionMePlayerExtras } from '@/lib/server/sessionMeExtras';



export const dynamic = 'force-dynamic';



export async function GET(request: Request) {

  const totalStartedAt = Date.now();

  const auth = await verifyAppSessionFromRequest(request, {
    acquireContext: { context: 'app_session_auth', route: '/api/auth/session/me' },
  });

  const authTiming = auth.timing;



  if (!auth.hit) {

    const total_ms = Date.now() - totalStartedAt;

    console.info('[APP_SESSION_ME]', {

      ok: false,

      reason: auth.reason,

      durationMs: total_ms,

    });

    console.info('[APP_SESSION_ME_TIMING]', {

      ok: false,

      reason: auth.reason,

      cookie_parse_ms: authTiming.cookie_parse_ms,

      session_lookup_ms: authTiming.session_lookup_ms,

      profile_lookup_ms: authTiming.profile_lookup_ms,

      pool_acquire_ms: authTiming.pool_acquire_ms,

      cache_lookup_ms: authTiming.cache_lookup_ms,

      client_release_ms: authTiming.client_release_ms,

      auth_finalize_ms: authTiming.auth_finalize_ms,

      auth_total_ms: authTiming.total_ms,

      serialization_ms: 0,

      response_ms: 0,

      total_ms,

      unaccounted_ms: Math.max(

        0,

        total_ms -

          authTiming.cookie_parse_ms -

          authTiming.cache_lookup_ms -

          authTiming.pool_acquire_ms -

          authTiming.session_lookup_ms -

          authTiming.profile_lookup_ms -

          authTiming.client_release_ms -

          authTiming.auth_finalize_ms

      ),

    });

    return NextResponse.json(

      { ok: false, reason: auth.reason },

      { status: auth.reason === 'missing_header' ? 401 : 401 }

    );

  }



  const serializationStartedAt = Date.now();

  const playerExtras =
    auth.role === 'player'
      ? await readSessionMePlayerExtras({
          uid: auth.uid,
          coadminUid: auth.coadminUid,
        })
      : null;

  const playerSessionId =
    auth.role === 'player'
      ? String(auth.profile.activeSessionId || '').trim() || null
      : null;

  const body = {

    ok: true as const,

    uid: auth.uid,

    role: auth.role,

    coadminUid: auth.coadminUid,

    username: auth.username,

    status: auth.profile.status,

    expiresAt: auth.session.expiresAt,

    appSessionId: auth.sessionId,

    sessionSource: 'sql' as const,

    ...(playerSessionId
      ? {
          playerSessionId,
          canonicalSessionId: playerSessionId,
        }
      : {}),

    ...(playerExtras
      ? {
          player: playerExtras,
        }
      : {}),

  };

  const serialization_ms = Date.now() - serializationStartedAt;



  const responseStartedAt = Date.now();

  const response = NextResponse.json(body);

  const response_ms = Date.now() - responseStartedAt;

  const total_ms = Date.now() - totalStartedAt;



  console.info('[APP_SESSION_ME]', {

    ok: true,

    uid: auth.uid,

    role: auth.role,

    source: 'sql',

    firestore_fallback: false,

    user_doc_ms: 0,

    durationMs: total_ms,

  });
  logSqlAuthProfileRead({
    uid: auth.uid,
    role: auth.role,
    source: 'sql',
    route: '/api/auth/session/me',
  });
  logSqlAuthSessionRead({
    uid: auth.uid,
    sessionId: auth.sessionId,
    source: 'sql',
    route: '/api/auth/session/me',
  });
  logSqlAuthNoFirestore('/api/auth/session/me', {
    uid: auth.uid,
    role: auth.role,
    app_session_id: auth.sessionId,
  });

  console.info('[APP_SESSION_ME_TIMING]', {

    ok: true,

    uid: auth.uid,

    role: auth.role,

    cookie_parse_ms: authTiming.cookie_parse_ms,

    session_lookup_ms: authTiming.session_lookup_ms,

    profile_lookup_ms: authTiming.profile_lookup_ms,

    pool_acquire_ms: authTiming.pool_acquire_ms,

    cache_lookup_ms: authTiming.cache_lookup_ms,

    client_release_ms: authTiming.client_release_ms,

    auth_finalize_ms: authTiming.auth_finalize_ms,

    auth_total_ms: authTiming.total_ms,

    serialization_ms,

    response_ms,

    total_ms,

    unaccounted_ms: Math.max(

      0,

      total_ms -

        authTiming.total_ms -

        serialization_ms -

        response_ms

    ),

  });



  return response;

}


