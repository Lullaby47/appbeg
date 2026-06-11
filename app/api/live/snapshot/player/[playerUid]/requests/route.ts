import { NextResponse } from 'next/server';

import { apiError, requirePlayerOwnedLiveAuth } from '@/lib/firebase/apiAuth';
import {
  cleanText,
  runMirrorClientQuery,
  toIsoString,
  withPlayerMirrorClient,
} from '@/lib/sql/playerMirrorCommon';
import { getLatestOutboxIdForChannels, playerRequestLiveChannel } from '@/lib/sql/liveOutbox';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const PLAYER_REQUEST_HISTORY_LIMIT = 40;
const PLAYER_REQUEST_ACTIVE_STATUSES = ['pending', 'poked', 'pending_review'];

const RECOMMENDED_SNAPSHOT_INDEXES = [
  'player_game_requests_cache(player_uid, created_at DESC) WHERE deleted_at IS NULL',
  'player_game_requests_cache(player_uid, status, created_at DESC) WHERE deleted_at IS NULL',
  'live_outbox(channel, outbox_id) WHERE deleted_at IS NULL',
];

type SnapshotRequest = {
  id: string;
  playerUid: string;
  gameName: string;
  type: string;
  status: string;
  amount: number | null;
  baseAmount: number | null;
  pokeMessage: string | null;
  dismissReasonCode: string | null;
  dismissReasonMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  pokedAt: string | null;
};

function readRawField(row: Record<string, unknown>, key: string) {
  const raw =
    row.raw_firestore_data && typeof row.raw_firestore_data === 'object'
      ? (row.raw_firestore_data as Record<string, unknown>)
      : null;
  return raw ? cleanText(raw[key]) || null : null;
}

function mapSnapshotRow(row: Record<string, unknown>): SnapshotRequest {
  return {
    id: cleanText(row.firebase_id),
    playerUid: cleanText(row.player_uid),
    gameName: cleanText(row.game_name),
    type: cleanText(row.type),
    status: cleanText(row.status),
    amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
    baseAmount: Number.isFinite(Number(row.base_amount)) ? Number(row.base_amount) : null,
    pokeMessage: cleanText(row.poke_message) || readRawField(row, 'pokeMessage'),
    dismissReasonCode:
      cleanText(row.dismiss_reason_code) || readRawField(row, 'dismissReasonCode'),
    dismissReasonMessage:
      cleanText(row.dismiss_reason_message) || readRawField(row, 'dismissReasonMessage'),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    completedAt: toIsoString(row.completed_at),
    pokedAt: toIsoString(row.poked_at),
  };
}

function sortByNewest(rows: SnapshotRequest[]) {
  return [...rows].sort((left, right) => {
    const leftMs = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
    const rightMs = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
    if (rightMs !== leftMs) return rightMs - leftMs;
    const leftCreated = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightCreated = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightCreated - leftCreated;
  });
}

function logSnapshotTiming(details: Record<string, unknown>) {
  console.info('[LIVE_SNAPSHOT_TIMING]', {
    recommendedIndexes: RECOMMENDED_SNAPSHOT_INDEXES,
    ...details,
  });
}

async function fetchSnapshotRowsOnClient(playerUid: string) {
  const startedAt = Date.now();
  const { result } = await withPlayerMirrorClient(
    {
      route: '/api/live/snapshot/player/[playerUid]/requests',
      context: 'player_requests_snapshot',
    },
    async (client, trackQuery) => {
      trackQuery();
      const recentResult = await runMirrorClientQuery<Record<string, unknown>>(
        client,
        `
          SELECT *
          FROM public.player_game_requests_cache
          WHERE player_uid = $1
            AND deleted_at IS NULL
          ORDER BY created_at DESC NULLS LAST
          LIMIT $2
        `,
        [playerUid, PLAYER_REQUEST_HISTORY_LIMIT]
      );

      trackQuery();
      const activeResult = await runMirrorClientQuery<Record<string, unknown>>(
        client,
        `
          SELECT *
          FROM public.player_game_requests_cache
          WHERE player_uid = $1
            AND deleted_at IS NULL
            AND status = ANY($2::text[])
          ORDER BY created_at DESC NULLS LAST
        `,
        [playerUid, PLAYER_REQUEST_ACTIVE_STATUSES]
      );

      trackQuery();
      const channel = playerRequestLiveChannel(playerUid);
      const outboxPack = await getLatestOutboxIdForChannels([channel], { mirrorClient: client });

      const merged = new Map<string, Record<string, unknown>>();
      for (const row of [...recentResult.rows, ...activeResult.rows]) {
        const firebaseId = cleanText(row.firebase_id);
        if (firebaseId) {
          merged.set(firebaseId, row);
        }
      }

      return {
        rows: Array.from(merged.values()),
        recentRowCount: recentResult.rows.length,
        activeRowCount: activeResult.rows.length,
        rawRowCount: merged.size,
        latestOutboxId: outboxPack.latestOutboxId,
      };
    }
  );

  if (!result) {
    return null;
  }

  return {
    ...result,
    durationMs: Date.now() - startedAt,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ playerUid: string }> }
) {
  const totalStartedAt = Date.now();

  const { playerUid: rawPlayerUid } = await params;
  const playerUid = cleanText(decodeURIComponent(rawPlayerUid || ''));
  if (!playerUid || playerUid.includes('/')) {
    logSnapshotTiming({
      auth_path: 'invalid_player_uid',
      verify_token_ms: 0,
      user_doc_ms: 0,
      session_check_ms: 0,
      sql_requests_ms: 0,
      sql_latest_outbox_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'invalid_player_uid',
    });
    return apiError('Player uid is required.', 400);
  }

  const auth = await requirePlayerOwnedLiveAuth(request, playerUid);
  if (!auth.ok) {
    logSnapshotTiming({
      ...auth.timing,
      sql_requests_ms: 0,
      sql_latest_outbox_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'auth_response',
      playerUid,
    });
    return auth.response;
  }

  try {
    const sqlStartedAt = Date.now();
    const snapshotPack = await fetchSnapshotRowsOnClient(playerUid);
    if (!snapshotPack) {
      logSnapshotTiming({
        ...auth.timing,
        sql_requests_ms: 0,
        sql_latest_outbox_ms: 0,
        total_ms: Date.now() - totalStartedAt,
        reason: 'postgres_unavailable',
        playerUid,
      });
      return NextResponse.json({
        requests: [],
        snapshotAt: new Date().toISOString(),
        latestOutboxId: 0,
        source: 'postgres_snapshot_unavailable',
      });
    }

    const requests = sortByNewest(snapshotPack.rows.map(mapSnapshotRow).filter((row) => row.id));
    const sqlDurationMs = Date.now() - sqlStartedAt;

    logSnapshotTiming({
      ...auth.timing,
      sql_requests_ms: sqlDurationMs,
      sql_latest_outbox_ms: sqlDurationMs,
      total_ms: Date.now() - totalStartedAt,
      playerUid,
      recentRowCount: snapshotPack.recentRowCount,
      activeRowCount: snapshotPack.activeRowCount,
      rawRowCount: snapshotPack.rawRowCount,
      mergedRowCount: requests.length,
      latestOutboxId: snapshotPack.latestOutboxId,
      sqlQueryMode: 'single_client_recent_active_outbox',
      connection_reused: true,
      query_count: 3,
    });

    return NextResponse.json({
      requests,
      snapshotAt: new Date().toISOString(),
      latestOutboxId: snapshotPack.latestOutboxId,
      source: 'postgres_snapshot',
    });
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'player_requests_snapshot', playerUid, error });
    logSnapshotTiming({
      ...auth.timing,
      sql_requests_ms: 0,
      sql_latest_outbox_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_snapshot_failed',
      playerUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({
      requests: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_failed',
    });
  }
}
