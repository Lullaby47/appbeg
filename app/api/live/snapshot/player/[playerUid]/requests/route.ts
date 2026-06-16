import { NextResponse } from 'next/server';

import { apiError, requirePlayerOwnedLiveAuth } from '@/lib/firebase/apiAuth';
import {
  cleanText,
  runMirrorClientQuery,
  toIsoString,
  withPlayerMirrorClient,
} from '@/lib/sql/playerMirrorCommon';
import {
  getLatestOutboxIdForChannels,
  playerCashoutLiveChannel,
  playerFreeplayLiveChannel,
  playerRequestLiveChannel,
} from '@/lib/sql/liveOutbox';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const PLAYER_REQUEST_HISTORY_LIMIT = 40;
const PLAYER_REQUEST_ACTIVE_STATUSES = [
  'pending',
  'poked',
  'pending_review',
  'waiting_player_exit',
  'retry_requested',
  'pending_automation',
];

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
  automationStatus: string | null;
  playerMessage: string | null;
  retryAttempt: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  pokedAt: string | null;
};

type SnapshotSqlTiming = {
  client_acquire_ms: number;
  requests_query_ms: number;
  latest_outbox_query_ms: number;
  serialization_ms: number;
  row_counts: {
    recent: number;
    active: number;
    raw: number;
    merged: number;
  };
  dominant_stage: { stage: string; ms: number };
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
    automationStatus: cleanText(row.automation_status) || readRawField(row, 'automationStatus'),
    playerMessage:
      readRawField(row, 'playerMessage') ||
      cleanText(row.poke_message) ||
      readRawField(row, 'pokeMessage'),
    retryAttempt: Number.isFinite(Number(row.retry_attempt))
      ? Number(row.retry_attempt)
      : Number.isFinite(Number(readRawField(row, 'retryAttempt')))
        ? Number(readRawField(row, 'retryAttempt'))
        : null,
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

function largestTimingStage(stages: Record<string, number>) {
  return Object.entries(stages).reduce(
    (largest, [stage, ms]) => (ms > largest.ms ? { stage, ms } : largest),
    { stage: 'none', ms: 0 }
  );
}

function logPlayerRequestSnapshotSqlTiming(details: SnapshotSqlTiming & Record<string, unknown>) {
  console.info('[PLAYER_REQUEST_SNAPSHOT_SQL_TIMING]', details);
}

async function fetchSnapshotRowsOnClient(playerUid: string) {
  const startedAt = Date.now();
  const channels = [
    playerRequestLiveChannel(playerUid),
    playerFreeplayLiveChannel(playerUid),
    playerCashoutLiveChannel(playerUid),
  ];
  const latestOutboxStartedAt = Date.now();
  const latestOutboxPromise = getLatestOutboxIdForChannels(channels).then((pack) => ({
    pack,
    ms: Date.now() - latestOutboxStartedAt,
  }));
  let requestsQueryMs = 0;
  const { result, summary } = await withPlayerMirrorClient(
    {
      route: '/api/live/snapshot/player/[playerUid]/requests',
      context: 'player_requests_snapshot',
    },
    async (client, trackQuery) => {
      trackQuery();
      const queryStartedAt = Date.now();
      const requestsResult = await runMirrorClientQuery<Record<string, unknown>>(
        client,
        `
          WITH recent AS (
            SELECT *, true AS snapshot_recent, false AS snapshot_active
            FROM public.player_game_requests_cache
            WHERE player_uid = $1
              AND deleted_at IS NULL
            ORDER BY created_at DESC NULLS LAST
            LIMIT $2
          ),
          active AS (
            SELECT *, false AS snapshot_recent, true AS snapshot_active
            FROM public.player_game_requests_cache
            WHERE player_uid = $1
              AND deleted_at IS NULL
              AND status = ANY($3::text[])
            ORDER BY created_at DESC NULLS LAST
          ),
          merged AS (
            SELECT * FROM recent
            UNION ALL
            SELECT * FROM active
          ),
          ranked AS (
            SELECT *,
              bool_or(snapshot_recent) OVER (PARTITION BY firebase_id) AS was_recent,
              bool_or(snapshot_active) OVER (PARTITION BY firebase_id) AS was_active,
              row_number() OVER (
                PARTITION BY firebase_id
                ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
              ) AS snapshot_rank
            FROM merged
          )
          SELECT *
          FROM ranked
          WHERE snapshot_rank = 1
          ORDER BY created_at DESC NULLS LAST
        `,
        [playerUid, PLAYER_REQUEST_HISTORY_LIMIT, PLAYER_REQUEST_ACTIVE_STATUSES]
      );
      requestsQueryMs = Date.now() - queryStartedAt;
      const rows = requestsResult.rows;
      const recentRowCount = rows.filter((row) => row.was_recent === true).length;
      const activeRowCount = rows.filter((row) => row.was_active === true).length;

      return {
        rows,
        recentRowCount,
        activeRowCount,
        rawRowCount: rows.length,
      };
    }
  );
  const latestOutbox = await latestOutboxPromise;

  if (!result) {
    return null;
  }

  const timing = {
    client_acquire_ms: summary?.pool_acquire_ms ?? 0,
    requests_query_ms: requestsQueryMs,
    latest_outbox_query_ms: latestOutbox.ms,
    serialization_ms: 0,
    row_counts: {
      recent: result.recentRowCount,
      active: result.activeRowCount,
      raw: result.rawRowCount,
      merged: result.rows.length,
    },
    dominant_stage: largestTimingStage({
      client_acquire_ms: summary?.pool_acquire_ms ?? 0,
      requests_query_ms: requestsQueryMs,
      latest_outbox_query_ms: latestOutbox.ms,
    }),
  };

  return {
    ...result,
    latestOutboxId: latestOutbox.pack.latestOutboxId,
    timing,
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
    const serializationStartedAt = Date.now();
    const response = NextResponse.json({
      requests,
      snapshotAt: new Date().toISOString(),
      latestOutboxId: snapshotPack.latestOutboxId,
      source: 'postgres_snapshot',
    });
    const serializationMs = Date.now() - serializationStartedAt;
    const sqlTiming = {
      ...snapshotPack.timing,
      serialization_ms: serializationMs,
      dominant_stage: largestTimingStage({
        client_acquire_ms: snapshotPack.timing.client_acquire_ms,
        requests_query_ms: snapshotPack.timing.requests_query_ms,
        latest_outbox_query_ms: snapshotPack.timing.latest_outbox_query_ms,
        serialization_ms: serializationMs,
      }),
    };
    logPlayerRequestSnapshotSqlTiming({
      ...sqlTiming,
      playerUid,
      total_sql_ms: sqlDurationMs,
      total_ms: Date.now() - totalStartedAt,
      query_mode: 'parallel_requests_cte_and_latest_outbox',
      recommendedIndexes: RECOMMENDED_SNAPSHOT_INDEXES,
    });

    logSnapshotTiming({
      ...auth.timing,
      sql_requests_ms: sqlDurationMs,
      sql_latest_outbox_ms: snapshotPack.timing.latest_outbox_query_ms,
      total_ms: Date.now() - totalStartedAt,
      playerUid,
      recentRowCount: snapshotPack.recentRowCount,
      activeRowCount: snapshotPack.activeRowCount,
      rawRowCount: snapshotPack.rawRowCount,
      mergedRowCount: requests.length,
      latestOutboxId: snapshotPack.latestOutboxId,
      sqlQueryMode: 'parallel_requests_cte_and_latest_outbox',
      connection_reused: false,
      query_count: 2,
    });

    return response;
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
