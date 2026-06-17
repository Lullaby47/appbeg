import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requirePlayerApiUser } from '@/lib/firebase/apiAuth';
import { logPlayerApiAuthOk } from '@/lib/server/playerApiAuthLog';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import { extractPgErrorDetails } from '@/lib/server/sqlErrorDetails';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import { recordRouteMetric } from '@/lib/server/logMetrics';
import { API_ROUTE_SLOW_MS, isPlayerVerboseLogs } from '@/lib/server/verboseLogs';
import {
  readPlayerGameLoginsCacheFullByPlayer,
  type CachedPlayerGameLogin,
} from '@/lib/sql/playerGameLoginsCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/play-data';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function toIsoString(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number };
  if (typeof maybe.toDate === 'function') return maybe.toDate().toISOString();
  if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis()).toISOString();
  if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000).toISOString();
  return null;
}

function mapFirestorePlayerGameLogin(
  docSnap: QueryDocumentSnapshot
): CachedPlayerGameLogin | null {
  const data = docSnap.data() as Record<string, unknown>;
  const playerUid = cleanText(data.playerUid);
  const gameName = cleanText(data.gameName);
  const coadminUid = cleanText(data.coadminUid || data.createdBy);
  const createdBy = cleanText(data.createdBy) || coadminUid;

  if (!playerUid || !gameName || !coadminUid || !createdBy) {
    return null;
  }

  return {
    id: docSnap.id,
    playerUid,
    playerUsername: cleanText(data.playerUsername),
    gameName,
    gameUsername: cleanText(data.gameUsername),
    gamePassword: String(data.gamePassword || ''),
    frontendUrl: cleanText(data.frontendUrl) || undefined,
    siteUrl: cleanText(data.siteUrl) || undefined,
    coadminUid,
    createdBy,
    createdAt: toIsoString(data.createdAt),
  };
}

function emptyPayload(source: 'postgres' | 'firestore' | 'none' = 'postgres') {
  return {
    gameLogins: [] as CachedPlayerGameLogin[],
    source,
    snapshotAt: new Date().toISOString(),
  };
}

function logPlayerPlayDataSuccess(details: Record<string, unknown> & { total_ms: number }) {
  recordRouteMetric({
    route: ROUTE,
    durationMs: details.total_ms,
    ok: true,
    slowThresholdMs: API_ROUTE_SLOW_MS,
  });
  if (!isPlayerVerboseLogs() && details.total_ms < API_ROUTE_SLOW_MS) {
    return;
  }
  console.info('[PLAYER_PLAY_DATA]', details);
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const headerSessions = sessionIdsFromRequest(request);

  try {
    const auth = await requirePlayerApiUser(request);
    if ('response' in auth) {
      logRouteSessionValidation(ROUTE, {
        ok: false,
        ...headerSessions,
        canonical_session_id: headerSessions.player_session_id,
        validates: 'player_session_sql',
        auth_path: auth.timing.auth_path,
        session_source: auth.timing.session_source,
      });
      return auth.response;
    }

    logRouteSessionValidation(ROUTE, {
      ok: true,
      ...headerSessions,
      canonical_session_id: headerSessions.player_session_id,
      validates: 'player_session_sql',
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      uid: auth.user.uid,
    });
    logPlayerApiAuthOk(request, {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      authPath: auth.authPath,
    });

    const playerUid = auth.user.uid;
    try {
      const cached = await readPlayerGameLoginsCacheFullByPlayer(playerUid);
      if (cached !== null) {
        const durationMs = Date.now() - startedAt;
        logCacheSqlRead(ROUTE, { playerUid, count: cached.length, durationMs });
        logPlayerPlayDataSuccess({
          source: 'postgres',
          count: cached.length,
          total_ms: durationMs,
        });
        return NextResponse.json({
          gameLogins: cached,
          source: 'postgres',
          snapshotAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.warn('[PLAYER_PLAY_DATA] postgres read failed', { playerUid, error });
    }

    if (isCacheSqlAuthoritative()) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'playerGameLogins', { playerUid });
      return NextResponse.json(emptyPayload('postgres'));
    }

    const snap = await adminDb
      .collection('playerGameLogins')
      .where('playerUid', '==', playerUid)
      .get();
    const gameLogins = snap.docs
      .map(mapFirestorePlayerGameLogin)
      .filter((login): login is CachedPlayerGameLogin => Boolean(login));
    const durationMs = Date.now() - startedAt;
    logPlayerPlayDataSuccess({
      source: 'firestore',
      count: gameLogins.length,
      total_ms: durationMs,
    });
    return NextResponse.json({
      gameLogins,
      source: 'firestore',
      snapshotAt: new Date().toISOString(),
    });
  } catch (error) {
    const pg = extractPgErrorDetails(error);
    console.error('[PLAYER_PLAY_DATA_ERROR]', {
      stage: 'route',
      durationMs: Date.now() - startedAt,
      ...pg,
    });
    return NextResponse.json(emptyPayload('none'));
  }
}
