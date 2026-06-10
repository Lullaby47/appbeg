import { NextResponse } from 'next/server';

import { isAuthSqlReadEnabled, isPlayerSessionSqlReadEnabled } from '@/lib/server/authSqlRead';
import { logSqlLoginNoFirestoreMirror } from '@/lib/server/sqlSessionNoFirestoreMirror';
import { requireFirebasePlayerUser } from '@/lib/server/playerSessionRouteAuth';
import { invalidatePlayerSessionStatusCache } from '@/lib/server/playerSessionStatus';
import { logRouteSessionValidation } from '@/lib/server/sessionAuthLog';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { startPlayerSessionInSql } from '@/lib/sql/playerSessionWrite';

export const dynamic = 'force-dynamic';

type StartBody = {
  deviceId?: unknown;
  userAgent?: unknown;
  platform?: unknown;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let uid = '';

  try {
    const auth = await requireFirebasePlayerUser(request);
    if ('response' in auth) {
      return auth.response;
    }
    uid = auth.uid;

    const body = (await request.json().catch(() => ({}))) as StartBody;
    const deviceId = cleanText(body.deviceId);
    if (!deviceId) {
      return NextResponse.json({ error: 'deviceId is required.' }, { status: 400 });
    }

    let sqlOk = false;
    let sessionId = '';
    let previousSessionIds: string[] = [];

    try {
      if (!isAuthSqlReadEnabled()) {
        const { mirrorPlayerById } = await import('@/lib/sql/playersCache');
        await mirrorPlayerById(uid, 'player_session_start_hydrate');
      }
      const result = await startPlayerSessionInSql({
        playerUid: uid,
        deviceId,
        userAgent: cleanText(body.userAgent) || null,
        platform: cleanText(body.platform) || null,
        actorSource: 'sql_player_session_start',
      });
      sqlOk = true;
      sessionId = result.sessionId;
      previousSessionIds = result.previousSessionIds;
      invalidatePlayerSessionStatusCache({ uid, reason: 'start' });
      for (const previousSessionId of previousSessionIds) {
        invalidatePlayerSessionStatusCache({
          uid,
          playerSessionId: previousSessionId,
          reason: 'replacement',
        });
      }
    } catch (error) {
      console.info('[PLAYER_SESSION_SQL]', {
        action: 'start',
        uid,
        sessionId: '',
        sql_ok: false,
        firestore_mirror_ok: false,
        previousSessionCount: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { ok: false, error: 'Failed to start player session in SQL.' },
        { status: 503 }
      );
    }

    const sqlReadMode = isPlayerSessionSqlReadEnabled();
    let firestoreMirrorOk: boolean | null = null;
    if (!sqlReadMode) {
      try {
        const { mirrorPlayerSessionStartToFirestore } = await import(
          '@/lib/server/playerSessionFirestoreMirror'
        );
        firestoreMirrorOk = await mirrorPlayerSessionStartToFirestore({
          playerUid: uid,
          sessionId,
          deviceId,
          userAgent: cleanText(body.userAgent) || null,
          platform: cleanText(body.platform) || null,
          previousSessionIds,
        });
      } catch (error) {
        console.warn('[PLAYER_SESSION_SQL] firestore mirror failed', {
          action: 'start',
          uid,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      const appSessionIdHeader = cleanText(request.headers.get('X-App-Session-Id'));
      logSqlLoginNoFirestoreMirror({
        route: '/api/auth/player-session/start',
        uid,
        role: 'player',
        playerSessionIdPrefix: sessionId.slice(0, 8),
        appSessionIdPrefix: appSessionIdHeader ? appSessionIdHeader.slice(0, 8) : null,
      });
    }

    console.info('[PLAYER_SESSION_SQL]', {
      action: 'start',
      uid,
      sessionId,
      sql_ok: sqlOk,
      firestore_mirror_ok: firestoreMirrorOk,
      previousSessionCount: previousSessionIds.length,
      durationMs: Date.now() - startedAt,
    });

    logRouteSessionValidation('/api/auth/player-session/start', {
      ok: true,
      uid,
      canonical_session_id: sessionId,
      player_session_id: sessionId,
      validates: 'player_session_sql',
      resumed: previousSessionIds.length === 0 && sqlOk,
      previous_session_count: previousSessionIds.length,
    });

    return NextResponse.json({
      ok: true,
      sessionId,
      sqlOk,
      firestoreMirrorOk,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start player session.';
    console.info('[PLAYER_SESSION_SQL]', {
      action: 'start',
      uid,
      sessionId: '',
      sql_ok: false,
      firestore_mirror_ok: false,
      previousSessionCount: 0,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
