import 'server-only';

import { adminDb } from '@/lib/firebase/admin';
import {
  mirrorFreeplayPendingGiftSnapshot,
  readFreeplayPendingGiftCache,
} from '@/lib/sql/freeplayPendingGiftsCache';
import {
  createPlayerRouteReadTrace,
  recordFirestoreRead,
  recordSqlRead,
  type PlayerRouteReadTrace,
} from '@/lib/server/playerRouteTiming';

export type FreeplayPendingReadResult = {
  hasPendingGift: boolean;
  giftId: string | null;
  trace: PlayerRouteReadTrace;
  dataSource: 'postgres' | 'firestore' | 'none';
  mirrorOk: boolean | null;
};

function resultFromMarker(
  marker: { type?: string; status?: string; giftId?: string } | undefined,
  exists: boolean
) {
  const hasPendingGift =
    exists &&
    String(marker?.type || '').toLowerCase() === 'freeplay' &&
    String(marker?.status || '').toLowerCase() === 'pending';

  return {
    hasPendingGift,
    giftId: hasPendingGift ? String(marker?.giftId || '').trim() : null,
  };
}

function logFreeplayPendingCache(input: {
  source: 'postgres' | 'firestore' | 'none';
  playerUid: string;
  hasPendingGift: boolean;
  sqlMs: number;
  firestoreMs: number;
  mirrorOk?: boolean | null;
  reason?: string;
}) {
  console.info('[FREEPLAY_PENDING_CACHE]', {
    source: input.source,
    playerUid: input.playerUid,
    hasPendingGift: input.hasPendingGift,
    sql_ms: input.sqlMs,
    firestore_ms: input.firestoreMs,
    mirror_ok: input.mirrorOk ?? null,
    reason: input.reason || null,
  });
}

async function loadFreeplayPendingGiftFromFirestore(
  playerUid: string,
  trace: PlayerRouteReadTrace,
  options?: { mirrorOnHit?: boolean }
) {
  const startedAt = Date.now();
  try {
    const markerSnap = await adminDb.collection('freeplayPendingGifts').doc(playerUid).get();
    const firestoreMs = Date.now() - startedAt;
    recordFirestoreRead(trace, {
      collection: 'freeplayPendingGifts',
      path: `freeplayPendingGifts/${playerUid}`,
      kind: 'get',
      durationMs: firestoreMs,
      docCount: markerSnap.exists ? 1 : 0,
    });

    const marker = markerSnap.data() as
      | { type?: string; status?: string; giftId?: string }
      | undefined;
    const parsed = resultFromMarker(marker, markerSnap.exists);

    let mirrorOk: boolean | null = null;
    if (options?.mirrorOnHit !== false) {
      mirrorOk = await mirrorFreeplayPendingGiftSnapshot(markerSnap, 'freeplay_pending_read');
    }

    return {
      ...parsed,
      dataSource: 'firestore' as const,
      firestoreMs,
      mirrorOk,
    };
  } catch (error) {
    const firestoreMs = Date.now() - startedAt;
    recordFirestoreRead(trace, {
      collection: 'freeplayPendingGifts',
      path: `freeplayPendingGifts/${playerUid}`,
      kind: 'get',
      durationMs: firestoreMs,
      docCount: 0,
    });
    throw error;
  }
}

export async function loadFreeplayPendingGift(playerUid: string): Promise<FreeplayPendingReadResult> {
  const trace = createPlayerRouteReadTrace();
  const cleanPlayerUid = String(playerUid || '').trim();
  const sqlStartedAt = Date.now();
  const cached = await readFreeplayPendingGiftCache(cleanPlayerUid);
  const sqlMs = Date.now() - sqlStartedAt;

  if (cached.missReason === null && cached.row) {
    recordSqlRead(trace, {
      table: 'freeplay_pending_gifts_cache',
      operation: 'get_by_player_uid',
      durationMs: sqlMs,
      rowCount: 1,
    });
    logFreeplayPendingCache({
      source: 'postgres',
      playerUid: cleanPlayerUid,
      hasPendingGift: cached.row.hasPendingGift,
      sqlMs,
      firestoreMs: 0,
    });
    return {
      hasPendingGift: cached.row.hasPendingGift,
      giftId: cached.row.hasPendingGift ? cached.row.giftId : null,
      trace,
      dataSource: 'postgres',
      mirrorOk: null,
    };
  }

  if (cached.missReason === 'row_missing') {
    recordSqlRead(trace, {
      table: 'freeplay_pending_gifts_cache',
      operation: 'get_by_player_uid_miss',
      durationMs: sqlMs,
      rowCount: 0,
    });
    logFreeplayPendingCache({
      source: 'postgres',
      playerUid: cleanPlayerUid,
      hasPendingGift: false,
      sqlMs,
      firestoreMs: 0,
      reason: 'sql_confirmed_miss',
    });
    return {
      hasPendingGift: false,
      giftId: null,
      trace,
      dataSource: 'postgres',
      mirrorOk: null,
    };
  }

  if (cached.missReason === 'postgres_unavailable') {
    try {
      const firestoreResult = await loadFreeplayPendingGiftFromFirestore(cleanPlayerUid, trace);
      logFreeplayPendingCache({
        source: 'firestore',
        playerUid: cleanPlayerUid,
        hasPendingGift: firestoreResult.hasPendingGift,
        sqlMs,
        firestoreMs: firestoreResult.firestoreMs,
        mirrorOk: firestoreResult.mirrorOk,
      });
      return {
        hasPendingGift: firestoreResult.hasPendingGift,
        giftId: firestoreResult.giftId,
        trace,
        dataSource: 'firestore',
        mirrorOk: firestoreResult.mirrorOk,
      };
    } catch (error) {
      console.warn('[FREEPLAY_PENDING_CACHE] firestore read failed', {
        playerUid: cleanPlayerUid,
        error: error instanceof Error ? error.message : String(error),
      });
      logFreeplayPendingCache({
        source: 'none',
        playerUid: cleanPlayerUid,
        hasPendingGift: false,
        sqlMs,
        firestoreMs: trace.firestoreMs,
        reason: 'firestore_unavailable_postgres_unavailable',
      });
      return {
        hasPendingGift: false,
        giftId: null,
        trace,
        dataSource: 'none',
        mirrorOk: false,
      };
    }
  }

  return {
    hasPendingGift: false,
    giftId: null,
    trace,
    dataSource: 'none',
    mirrorOk: null,
  };
}
