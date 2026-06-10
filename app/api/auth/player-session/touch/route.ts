import { NextResponse } from 'next/server';

import { isPlayerSessionSqlReadEnabled } from '@/lib/server/authSqlRead';
import { logSqlLoginNoFirestoreMirror } from '@/lib/server/sqlSessionNoFirestoreMirror';
import { requirePlayerSessionActor } from '@/lib/server/playerSessionRouteAuth';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { touchPlayerSessionInSql } from '@/lib/sql/playerSessionWrite';

export const dynamic = 'force-dynamic';

type TouchBody = {
  sessionId?: unknown;
  deviceId?: unknown;
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let uid = '';
  let sessionId = '';

  try {
    const auth = await requirePlayerSessionActor(request);
    if ('response' in auth) {
      return auth.response;
    }
    uid = auth.uid;

    const body = (await request.json().catch(() => ({}))) as TouchBody;
    sessionId = cleanText(body.sessionId);
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required.' }, { status: 400 });
    }

    const touchResult = await touchPlayerSessionInSql({
      playerUid: uid,
      sessionId,
      deviceId: cleanText(body.deviceId) || null,
    });

    const sqlReadMode = isPlayerSessionSqlReadEnabled();
    if (touchResult.ok && !sqlReadMode) {
      const { mirrorPlayerSessionTouchToFirestore } = await import(
        '@/lib/server/playerSessionFirestoreMirror'
      );
      void mirrorPlayerSessionTouchToFirestore({
        playerUid: uid,
        sessionId,
        deviceId: cleanText(body.deviceId) || null,
      })
        .then((firestoreMirrorOk) => {
          console.info('[PLAYER_SESSION_SQL]', {
            action: 'touch_mirror_async',
            uid,
            sessionId,
            firestore_mirror_ok: firestoreMirrorOk,
          });
        })
        .catch((error) => {
          console.warn('[PLAYER_SESSION_SQL] firestore mirror failed', {
            action: 'touch',
            uid,
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    } else if (touchResult.ok && sqlReadMode) {
      const appSessionIdHeader = cleanText(request.headers.get('X-App-Session-Id'));
      logSqlLoginNoFirestoreMirror({
        route: '/api/auth/player-session/touch',
        uid,
        role: 'player',
        playerSessionIdPrefix: sessionId.slice(0, 8),
        appSessionIdPrefix: appSessionIdHeader ? appSessionIdHeader.slice(0, 8) : null,
      });
    }

    const durationMs = Date.now() - startedAt;
    console.info('[PLAYER_SESSION_SQL]', {
      action: 'touch',
      uid,
      sessionId,
      sql_ok: touchResult.ok,
      firestore_mirror_ok: null,
      firestore_mirror_async: sqlReadMode ? null : touchResult.ok,
      previousSessionCount: 0,
      durationMs,
      reason: touchResult.reason || null,
    });

    return NextResponse.json({
      ok: touchResult.ok,
      reason: touchResult.reason || null,
      sqlOk: touchResult.ok,
      firestoreMirrorOk: sqlReadMode ? null : null,
      firestoreMirrorAsync: sqlReadMode ? null : touchResult.ok,
      durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to touch player session.';
    console.info('[PLAYER_SESSION_SQL]', {
      action: 'touch',
      uid,
      sessionId,
      sql_ok: false,
      firestore_mirror_ok: false,
      previousSessionCount: 0,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
