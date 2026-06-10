import { NextResponse } from 'next/server';

import { isPlayerSessionSqlReadEnabled } from '@/lib/server/authSqlRead';
import { logSqlLoginNoFirestoreMirror } from '@/lib/server/sqlSessionNoFirestoreMirror';
import { requirePlayerSessionActor } from '@/lib/server/playerSessionRouteAuth';
import { invalidatePlayerSessionStatusCache } from '@/lib/server/playerSessionStatus';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { endPlayerSessionInSql } from '@/lib/sql/playerSessionWrite';

export const dynamic = 'force-dynamic';

type EndBody = {
  sessionId?: unknown;
  reason?: unknown;
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

    const body = (await request.json().catch(() => ({}))) as EndBody;
    sessionId = cleanText(body.sessionId);
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required.' }, { status: 400 });
    }

    const reason = cleanText(body.reason) || 'logout';
    const appSessionIdHeader = cleanText(request.headers.get('X-App-Session-Id'));
    const playerSessionIdHeader = cleanText(request.headers.get('X-Player-Session-Id'));

    console.info('[PLAYER_SESSION_END_SERVER]', {
      uid,
      sessionId,
      reason,
      requestPath: new URL(request.url).pathname,
      userAgent: cleanText(request.headers.get('user-agent')) || null,
      referer: cleanText(request.headers.get('referer')) || null,
      appSessionIdPrefix: appSessionIdHeader ? appSessionIdHeader.slice(0, 8) : null,
      playerSessionIdPrefix: playerSessionIdHeader
        ? playerSessionIdHeader.slice(0, 8)
        : sessionId
          ? sessionId.slice(0, 8)
          : null,
    });

    invalidatePlayerSessionStatusCache({
      playerSessionId: sessionId,
      uid,
      appSessionId: cleanText(request.headers.get('X-App-Session-Id')),
      reason: reason === 'logout' ? 'logout' : 'end',
    });
    const endResult = await endPlayerSessionInSql({
      playerUid: uid,
      sessionId,
      reason,
    });

    const sqlReadMode = isPlayerSessionSqlReadEnabled();
    let firestoreMirrorOk: boolean | null = null;
    if (endResult.ok && !sqlReadMode) {
      try {
        const { mirrorPlayerSessionEndToFirestore } = await import(
          '@/lib/server/playerSessionFirestoreMirror'
        );
        firestoreMirrorOk = await mirrorPlayerSessionEndToFirestore({
          playerUid: uid,
          sessionId,
          reason,
        });
      } catch (error) {
        firestoreMirrorOk = false;
        console.warn('[PLAYER_SESSION_SQL] firestore mirror failed', {
          action: 'end',
          uid,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (endResult.ok && sqlReadMode) {
      logSqlLoginNoFirestoreMirror({
        route: '/api/auth/player-session/end',
        uid,
        role: 'player',
        playerSessionIdPrefix: sessionId.slice(0, 8),
        appSessionIdPrefix: appSessionIdHeader ? appSessionIdHeader.slice(0, 8) : null,
      });
    }

    console.info('[PLAYER_SESSION_SQL]', {
      action: 'end',
      uid,
      sessionId,
      sql_ok: endResult.ok,
      firestore_mirror_ok: firestoreMirrorOk,
      previousSessionCount: 0,
      durationMs: Date.now() - startedAt,
      reason: endResult.reason || reason,
    });

    return NextResponse.json({
      ok: endResult.ok,
      reason: endResult.reason || null,
      sqlOk: endResult.ok,
      firestoreMirrorOk,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to end player session.';
    console.info('[PLAYER_SESSION_SQL]', {
      action: 'end',
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
