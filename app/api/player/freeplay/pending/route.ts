import { NextResponse } from 'next/server';

import {
  apiUserAuthFirestoreMs,
  apiUserAuthSqlMs,
  requireApiUser,
} from '@/lib/firebase/apiAuth';
import { loadFreeplayPendingGift } from '@/lib/server/playerFreeplayPendingRead';
import { logPlayerRouteTiming } from '@/lib/server/playerRouteTiming';

export async function GET(request: Request) {
  const startedAt = Date.now();
  let authMs = 0;
  let authSqlMs = 0;
  let authFirestoreMs = 0;

  try {
    const auth = await requireApiUser(request, ['player']);
    authMs = auth.timing.auth_ms;
    authSqlMs = apiUserAuthSqlMs(auth.timing);
    authFirestoreMs = apiUserAuthFirestoreMs(auth.timing);

    if ('response' in auth) {
      const totalMs = Date.now() - startedAt;
      logPlayerRouteTiming('[PLAYER_FREEPLAY_PENDING]', {
        ok: false,
        reason: 'auth_denied',
        status: auth.response.status,
        auth_ms: authMs,
        sql_ms: authSqlMs,
        firestore_ms: authFirestoreMs,
        total_ms: totalMs,
        auth_firestore_reads:
          authFirestoreMs > 0
            ? [
                {
                  collection: 'playerSessions|users',
                  path: 'requireApiUser/session_or_profile_fallback',
                  kind: 'get',
                  source: 'firestore',
                },
              ]
            : [],
      });
      return auth.response;
    }

    const pending = await loadFreeplayPendingGift(auth.user.uid);
    const dataSqlMs = pending.trace.sqlMs;
    const dataFirestoreMs = pending.trace.firestoreMs;
    const totalMs = Date.now() - startedAt;

    logPlayerRouteTiming('[PLAYER_FREEPLAY_PENDING]', {
      ok: true,
      uid: auth.user.uid,
      hasPendingGift: pending.hasPendingGift,
      data_source: pending.dataSource,
      mirror_ok: pending.mirrorOk,
      sql_cache_available: true,
      auth_ms: authMs,
      sql_ms: authSqlMs + dataSqlMs,
      firestore_ms: authFirestoreMs + dataFirestoreMs,
      total_ms: totalMs,
      trace: pending.trace,
    });

    return NextResponse.json({
      success: true,
      hasPendingGift: pending.hasPendingGift,
      giftId: pending.giftId,
      source: pending.dataSource,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load FreePlay gift.';
    const totalMs = Date.now() - startedAt;
    logPlayerRouteTiming('[PLAYER_FREEPLAY_PENDING]', {
      ok: false,
      error: message,
      auth_ms: authMs,
      sql_ms: authSqlMs,
      firestore_ms: authFirestoreMs,
      total_ms: totalMs,
    });
    return NextResponse.json(
      { error: message },
      { status: /authorization|token|logged out/i.test(message) ? 401 : 400 }
    );
  }
}
