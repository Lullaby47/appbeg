import { NextResponse } from 'next/server';

import { apiError, requireCarerOwnedLiveAuth } from '@/lib/firebase/apiAuth';
import {
  carerTaskLiveChannel,
  coadminTaskLiveChannel,
  getLatestOutboxIdForChannels,
} from '@/lib/sql/liveOutbox';
import {
  acquirePlayerMirrorClient,
  cleanText,
  createPlayerMirrorSqlTiming,
  getPlayerMirrorPool,
  runMirrorClientQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export const dynamic = 'force-dynamic';

const CARER_TASK_HISTORY_LIMIT = 100;
const CARER_TASK_ACTIVE_STATUSES = ['pending', 'in_progress', 'urgent', 'pending_review'];

const RECOMMENDED_SNAPSHOT_INDEXES = [
  'carer_tasks_cache(coadmin_uid, created_at DESC) WHERE deleted_at IS NULL',
  'carer_tasks_cache(coadmin_uid, status, created_at DESC) WHERE deleted_at IS NULL',
  'carer_tasks_cache(assigned_carer_uid, status, created_at DESC) WHERE deleted_at IS NULL',
  'live_outbox(channel, outbox_id) WHERE deleted_at IS NULL',
];

type SnapshotTask = {
  id: string;
  taskId: string;
  coadminUid: string;
  playerUid: string;
  type: string;
  status: string;
  automationStatus: string | null;
  gameName: string;
  amount: number | null;
  requestId: string | null;
  assignedCarerUid: string | null;
  claimedByUid: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
};

function mapSnapshotRow(row: Record<string, unknown>): SnapshotTask {
  return {
    id: cleanText(row.firebase_id),
    taskId: cleanText(row.firebase_id),
    coadminUid: cleanText(row.coadmin_uid),
    playerUid: cleanText(row.player_uid),
    type: cleanText(row.type),
    status: cleanText(row.status),
    automationStatus: cleanText(row.automation_status) || null,
    gameName: cleanText(row.game_name),
    amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
    requestId: cleanText(row.request_id) || null,
    assignedCarerUid: cleanText(row.assigned_carer_uid) || null,
    claimedByUid: cleanText(row.claimed_by_uid) || null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    completedAt: toIsoString(row.completed_at),
  };
}

function isVisibleCarerTaskForCarer(task: SnapshotTask, carerUid: string) {
  const status = cleanText(task.status).toLowerCase();
  const assignedCarerUid = cleanText(task.assignedCarerUid);

  if (status === 'completed') {
    return true;
  }
  if (status === 'failed') {
    return false;
  }
  if (status === 'urgent') {
    return assignedCarerUid === carerUid;
  }
  if (status === 'pending') {
    return !assignedCarerUid || assignedCarerUid === carerUid;
  }
  return assignedCarerUid === carerUid;
}

function snapshotRowHiddenReason(task: SnapshotTask, carerUid: string): string | null {
  if (isVisibleCarerTaskForCarer(task, carerUid)) {
    return null;
  }
  const status = cleanText(task.status).toLowerCase();
  const assignedCarerUid = cleanText(task.assignedCarerUid);
  if (status === 'failed') {
    return 'status_failed';
  }
  if (status === 'urgent' && assignedCarerUid !== carerUid) {
    return 'urgent_assigned_to_other_carer';
  }
  if (status === 'pending' && assignedCarerUid && assignedCarerUid !== carerUid) {
    return 'pending_assigned_to_other_carer';
  }
  if (assignedCarerUid && assignedCarerUid !== carerUid) {
    return 'assigned_to_other_carer';
  }
  return 'not_visible_to_carer';
}

function logCarerSnapshotRowAudit(input: {
  task: SnapshotTask;
  carerUid: string;
  includedInRawRows: boolean;
  includedInVisibleRows: boolean;
  hiddenReason: string | null;
}) {
  const taskType = cleanText(input.task.type).toLowerCase();
  if (taskType !== 'recharge' && taskType !== 'redeem') {
    return;
  }
  console.info('[CARER_SNAPSHOT_ROW_AUDIT]', {
    taskId: input.task.id,
    taskType,
    status: input.task.status,
    playerUid: input.task.playerUid,
    coadminUid: input.task.coadminUid,
    assignedCarerUid: input.task.assignedCarerUid,
    deletedAt: null,
    includedInRawRows: input.includedInRawRows,
    includedInVisibleRows: input.includedInVisibleRows,
    hiddenReason: input.hiddenReason,
  });
}

function sortByNewest(rows: SnapshotTask[]) {
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
  console.info('[LIVE_CARER_TASKS_SNAPSHOT_TIMING]', {
    recommendedIndexes: RECOMMENDED_SNAPSHOT_INDEXES,
    shadowLimitation:
      'Unassigned pending/urgent outbox events use coadmin:{coadminUid}:tasks; carer SSE may lag pool tasks until assigned.',
    ...details,
  });
}

function authTimingDetails(timing: {
  auth_path: string;
  auth_ms: number;
  verify_token_ms: number;
  sql_profile_ms: number;
  sql_profile_query_ms: number;
  sql_profile_pool_acquire_ms: number;
  sql_profile_query_exec_ms: number;
  sql_profile_total_ms: number;
  user_doc_ms: number;
  token_cache_hit: boolean;
  firestore_fallback?: boolean;
  source?: string;
}) {
  return {
    auth_path: timing.auth_path,
    auth_ms: timing.auth_ms,
    verify_token_ms: timing.verify_token_ms,
    token_cache_hit: timing.token_cache_hit,
    sql_profile_ms: timing.sql_profile_ms,
    sql_profile_query_ms: timing.sql_profile_query_ms,
    sql_profile_pool_acquire_ms: timing.sql_profile_pool_acquire_ms,
    sql_profile_query_exec_ms: timing.sql_profile_query_exec_ms,
    sql_profile_total_ms: timing.sql_profile_total_ms,
    user_doc_ms: timing.user_doc_ms,
    source: timing.source || (timing.firestore_fallback ? 'firestore' : 'sql'),
    firestore_fallback: timing.firestore_fallback ?? timing.user_doc_ms > 0,
  };
}

async function fetchSnapshotRowsWithClient(
  client: import('pg').PoolClient,
  coadminUid: string
) {
  const totalStartedAt = Date.now();
  const recentPack = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    `
      SELECT *
      FROM public.carer_tasks_cache
      WHERE coadmin_uid = $1
        AND deleted_at IS NULL
        AND COALESCE(LOWER(status), '') <> 'deleted'
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2
    `,
    [coadminUid, CARER_TASK_HISTORY_LIMIT]
  );
  const activePack = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    `
      SELECT *
      FROM public.carer_tasks_cache
      WHERE coadmin_uid = $1
        AND deleted_at IS NULL
        AND COALESCE(LOWER(status), '') <> 'deleted'
        AND status = ANY($2::text[])
      ORDER BY created_at DESC NULLS LAST
    `,
    [coadminUid, CARER_TASK_ACTIVE_STATUSES]
  );

  const timing = createPlayerMirrorSqlTiming({
    pool_acquire_ms: 0,
    query_exec_ms: recentPack.timing.query_exec_ms + activePack.timing.query_exec_ms,
    total_ms: Date.now() - totalStartedAt,
  });

  const merged = new Map<string, Record<string, unknown>>();
  for (const row of [...recentPack.rows, ...activePack.rows]) {
    const firebaseId = cleanText(row.firebase_id);
    if (firebaseId) {
      merged.set(firebaseId, row);
    }
  }

  return {
    rows: Array.from(merged.values()),
    timing,
    recentRowCount: recentPack.rows.length,
    activeRowCount: activePack.rows.length,
    rawRowCount: merged.size,
    recent_query_exec_ms: recentPack.timing.query_exec_ms,
    active_query_exec_ms: activePack.timing.query_exec_ms,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ carerUid: string }> }
) {
  const totalStartedAt = Date.now();

  const { carerUid: rawCarerUid } = await params;
  const carerUid = cleanText(decodeURIComponent(rawCarerUid || ''));
  if (!carerUid || carerUid.includes('/')) {
    logSnapshotTiming({
      auth_ms: 0,
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'invalid_carer_uid',
    });
    return apiError('Carer uid is required.', 400);
  }

  const auth = await requireCarerOwnedLiveAuth(request, carerUid);
  if (!auth.ok) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'auth_response',
      carerUid,
    });
    return auth.response;
  }

  if (!auth.coadminUid) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'missing_coadmin_scope',
      carerUid,
    });
    return NextResponse.json({
      tasks: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_unscoped',
    });
  }

  if (!getPlayerMirrorPool()) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_unavailable',
      carerUid,
      coadminUid: auth.coadminUid,
    });
    return NextResponse.json({
      tasks: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_unavailable',
    });
  }

  const acquired = await acquirePlayerMirrorClient({
    context: 'live_carer_tasks_snapshot',
    route: '/api/live/snapshot/carer/[carerUid]/tasks',
  });
  if (!acquired) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: 0,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_unavailable',
      carerUid,
      coadminUid: auth.coadminUid,
    });
    return NextResponse.json({
      tasks: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_unavailable',
    });
  }

  const { client } = acquired;
  const sqlConnectionAcquireMs = acquired.timing.pool_acquire_ms;

  try {
    const streamChannels = [
      carerTaskLiveChannel(carerUid),
      coadminTaskLiveChannel(auth.coadminUid),
    ];

    const snapshotPack = await fetchSnapshotRowsWithClient(client, auth.coadminUid);
    const outboxPack = await getLatestOutboxIdForChannels(streamChannels, {
      mirrorClient: client,
    });

    const mergeStartedAt = Date.now();
    const mapped = snapshotPack.rows.map(mapSnapshotRow).filter((row) => row.id);
    const visible = mapped.filter((task) => {
      const included = isVisibleCarerTaskForCarer(task, carerUid);
      logCarerSnapshotRowAudit({
        task,
        carerUid,
        includedInRawRows: true,
        includedInVisibleRows: included,
        hiddenReason: included ? null : snapshotRowHiddenReason(task, carerUid),
      });
      return included;
    });
    const tasks = sortByNewest(visible);
    const mergeMs = Date.now() - mergeStartedAt;

    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      sql_connection_acquire_ms: sqlConnectionAcquireMs,
      sql_connection_shared: false,
      auth_before_snapshot_acquire: true,
      sql_tasks_ms: snapshotPack.timing.total_ms,
      sql_tasks_pool_acquire_ms: snapshotPack.timing.pool_acquire_ms,
      sql_tasks_query_exec_ms: snapshotPack.timing.query_exec_ms,
      sql_tasks_recent_query_exec_ms: snapshotPack.recent_query_exec_ms,
      sql_tasks_active_query_exec_ms: snapshotPack.active_query_exec_ms,
      sql_latest_outbox_ms: outboxPack.timing.total_ms,
      sql_latest_outbox_pool_acquire_ms: outboxPack.timing.pool_acquire_ms,
      sql_latest_outbox_query_exec_ms: outboxPack.timing.query_exec_ms,
      merge_ms: mergeMs,
      total_ms: Date.now() - totalStartedAt,
      carerUid,
      coadminUid: auth.coadminUid,
      recentRowCount: snapshotPack.recentRowCount,
      activeRowCount: snapshotPack.activeRowCount,
      rawRowCount: snapshotPack.rawRowCount,
      mappedRowCount: mapped.length,
      visibleRowCount: visible.length,
      mergedRowCount: tasks.length,
      latestOutboxId: outboxPack.latestOutboxId,
    });

    return NextResponse.json({
      tasks,
      snapshotAt: new Date().toISOString(),
      latestOutboxId: outboxPack.latestOutboxId,
      source: 'postgres_snapshot',
    });
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'carer_tasks_snapshot', carerUid, error });
    logSnapshotTiming({
      sql_connection_acquire_ms: sqlConnectionAcquireMs,
      sql_connection_shared: true,
      sql_tasks_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_snapshot_failed',
      carerUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({
      tasks: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_failed',
    });
  } finally {
    client.release();
  }
}
