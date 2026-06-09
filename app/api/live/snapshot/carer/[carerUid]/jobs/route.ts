import { NextResponse } from 'next/server';

import { apiError, requireCarerOwnedLiveAuth } from '@/lib/firebase/apiAuth';
import { acquireAutomationJobsClient } from '@/lib/sql/automationJobsCache';
import { carerJobLiveChannel, getLatestOutboxIdForChannels } from '@/lib/sql/liveOutbox';
import {
  cleanText,
  createPlayerMirrorSqlTiming,
  runMirrorClientQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export const dynamic = 'force-dynamic';

const AUTOMATION_JOB_HISTORY_LIMIT = 100;
const AUTOMATION_JOB_ACTIVE_STATUSES = [
  'pending',
  'claimed',
  'in_progress',
  'running',
  'retrying',
  'pending_review',
  'queued',
  'cancelled_requested',
  'processing',
  'waiting',
];

const AUTOMATION_JOB_SNAPSHOT_SELECT = `
  job_id,
  task_id,
  coadmin_uid,
  carer_uid,
  created_by_uid,
  agent_id,
  type,
  request_type,
  status,
  game,
  created_at,
  updated_at,
  started_at,
  last_heartbeat_at,
  needs_manual_review,
  error_message
`;

const RECOMMENDED_SNAPSHOT_INDEXES = [
  'idx_automation_jobs_cache_created_by_recent (created_by_uid, created_at DESC) WHERE deleted_at IS NULL',
  'automation_jobs_cache_carer_created_idx (carer_uid, created_at DESC) WHERE deleted_at IS NULL',
  'automation_jobs_cache_created_by_status_updated_idx (created_by_uid, status, updated_at DESC) WHERE deleted_at IS NULL',
  'automation_jobs_cache_carer_status_updated_idx (carer_uid, status, updated_at DESC) WHERE deleted_at IS NULL',
  'live_outbox_channel_outbox_id_active_idx (channel, outbox_id DESC) WHERE deleted_at IS NULL',
];

function createdAtSortKey(row: Record<string, unknown>) {
  const iso = toIsoString(row.created_at);
  return iso ? new Date(iso).getTime() : 0;
}

function mergeRecentJobRows(
  createdByRows: Record<string, unknown>[],
  carerRows: Record<string, unknown>[],
  limit: number
) {
  const merged = new Map<string, Record<string, unknown>>();
  for (const row of [...createdByRows, ...carerRows]) {
    const jobId = cleanText(row.job_id);
    if (!jobId) continue;
    const existing = merged.get(jobId);
    if (!existing || createdAtSortKey(row) > createdAtSortKey(existing)) {
      merged.set(jobId, row);
    }
  }
  return Array.from(merged.values())
    .sort((left, right) => createdAtSortKey(right) - createdAtSortKey(left))
    .slice(0, limit);
}

type SnapshotJob = {
  id: string;
  jobId: string;
  taskId: string;
  coadminUid: string;
  carerUid: string;
  agentId: string | null;
  type: string;
  status: string;
  gameName: string;
  requestId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  needsManualReview: boolean | null;
  errorMessage: string | null;
};

function extractRequestId(taskId: string) {
  const cleanTaskId = cleanText(taskId);
  if (cleanTaskId.startsWith('request__')) {
    return cleanText(cleanTaskId.slice('request__'.length)) || null;
  }
  return null;
}

function mapSnapshotRow(row: Record<string, unknown>): SnapshotJob {
  const jobId = cleanText(row.job_id);
  const taskId = cleanText(row.task_id);
  return {
    id: jobId,
    jobId,
    taskId,
    coadminUid: cleanText(row.coadmin_uid),
    carerUid: cleanText(row.carer_uid) || cleanText(row.created_by_uid),
    agentId: cleanText(row.agent_id) || null,
    type: cleanText(row.type) || cleanText(row.request_type),
    status: cleanText(row.status),
    gameName: cleanText(row.game),
    requestId: extractRequestId(taskId),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: toIsoString(row.started_at),
    lastHeartbeatAt: toIsoString(row.last_heartbeat_at),
    needsManualReview:
      typeof row.needs_manual_review === 'boolean' ? row.needs_manual_review : null,
    errorMessage: cleanText(row.error_message) || null,
  };
}

function sortByNewest(rows: SnapshotJob[]) {
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
  console.info('[LIVE_AUTOMATION_JOBS_SNAPSHOT_TIMING]', {
    recommendedIndexes: RECOMMENDED_SNAPSHOT_INDEXES,
    shadowLimitation:
      'Pool jobs without carerUid emit on coadmin:{coadminUid}:jobs; carer snapshot scopes to created_by_uid/carer_uid only.',
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
  carerUid: string
) {
  const totalStartedAt = Date.now();
  const recentByCreatedByPack = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    `
      SELECT ${AUTOMATION_JOB_SNAPSHOT_SELECT}
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND created_by_uid = $1
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2
    `,
    [carerUid, AUTOMATION_JOB_HISTORY_LIMIT]
  );
  const recentByCarerPack = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    `
      SELECT ${AUTOMATION_JOB_SNAPSHOT_SELECT}
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND carer_uid = $1
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2
    `,
    [carerUid, AUTOMATION_JOB_HISTORY_LIMIT]
  );
  const activeByCreatedByPack = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    `
      SELECT ${AUTOMATION_JOB_SNAPSHOT_SELECT}
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND created_by_uid = $1
        AND status = ANY($2::text[])
      ORDER BY updated_at DESC NULLS LAST
    `,
    [carerUid, AUTOMATION_JOB_ACTIVE_STATUSES]
  );
  const activeByCarerPack = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    `
      SELECT ${AUTOMATION_JOB_SNAPSHOT_SELECT}
      FROM public.automation_jobs_cache
      WHERE deleted_at IS NULL
        AND carer_uid = $1
        AND status = ANY($2::text[])
      ORDER BY updated_at DESC NULLS LAST
    `,
    [carerUid, AUTOMATION_JOB_ACTIVE_STATUSES]
  );

  const recentRows = mergeRecentJobRows(
    recentByCreatedByPack.rows,
    recentByCarerPack.rows,
    AUTOMATION_JOB_HISTORY_LIMIT
  );
  const activeRows = [...activeByCreatedByPack.rows, ...activeByCarerPack.rows];
  const recentQueryExecMs =
    recentByCreatedByPack.timing.query_exec_ms + recentByCarerPack.timing.query_exec_ms;
  const activeQueryExecMs =
    activeByCreatedByPack.timing.query_exec_ms + activeByCarerPack.timing.query_exec_ms;

  const timing = createPlayerMirrorSqlTiming({
    pool_acquire_ms: 0,
    query_exec_ms: recentQueryExecMs + activeQueryExecMs,
    total_ms: Date.now() - totalStartedAt,
  });

  const merged = new Map<string, Record<string, unknown>>();
  for (const row of [...recentRows, ...activeRows]) {
    const jobId = cleanText(row.job_id);
    if (jobId) {
      merged.set(jobId, row);
    }
  }

  return {
    rows: Array.from(merged.values()),
    timing,
    recentRowCount: recentRows.length,
    activeRowCount: activeRows.length,
    rawRowCount: merged.size,
    recent_query_exec_ms: recentQueryExecMs,
    active_query_exec_ms: activeQueryExecMs,
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
      shared_client: false,
      client_acquire_ms: 0,
      auth_sql_ms: 0,
      jobs_sql_ms: 0,
      outbox_sql_ms: 0,
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
      shared_client: false,
      client_acquire_ms: 0,
      auth_sql_ms: auth.timing.sql_profile_total_ms,
      jobs_sql_ms: 0,
      outbox_sql_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'auth_response',
      carerUid,
    });
    return auth.response;
  }

  const jobsPoolAcquire = await acquireAutomationJobsClient({
    context: 'live_automation_jobs_snapshot',
    route: '/api/live/snapshot/carer/[carerUid]/jobs',
  });
  if (!jobsPoolAcquire) {
    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      shared_client: false,
      client_acquire_ms: 0,
      auth_sql_ms: auth.timing.sql_profile_total_ms,
      jobs_sql_ms: 0,
      outbox_sql_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_unavailable',
      carerUid,
      coadminUid: auth.coadminUid,
    });
    return NextResponse.json({
      jobs: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_unavailable',
    });
  }

  const { client } = jobsPoolAcquire;
  const clientAcquireMs = jobsPoolAcquire.pool_acquire_ms;

  try {
    const channel = carerJobLiveChannel(carerUid);

    const jobsSqlStartedAt = Date.now();
    const snapshotPack = await fetchSnapshotRowsWithClient(client, carerUid);
    const jobsSqlMs = Date.now() - jobsSqlStartedAt;

    const outboxSqlStartedAt = Date.now();
    const outboxPack = await getLatestOutboxIdForChannels([channel], {
      acquireContext: {
        context: 'live_automation_jobs_outbox',
        route: '/api/live/snapshot/carer/[carerUid]/jobs',
      },
    });
    const outboxSqlMs = Date.now() - outboxSqlStartedAt;

    const mergeStartedAt = Date.now();
    const jobs = sortByNewest(snapshotPack.rows.map(mapSnapshotRow).filter((row) => row.id));
    const mergeMs = Date.now() - mergeStartedAt;

    logSnapshotTiming({
      ...authTimingDetails(auth.timing),
      shared_client: false,
      jobs_pool: 'automationJobsCache',
      row_width_mode: 'narrow',
      client_acquire_ms: clientAcquireMs,
      auth_sql_ms: auth.timing.sql_profile_total_ms,
      jobs_sql_ms: jobsSqlMs,
      jobs_query_exec_ms: snapshotPack.timing.query_exec_ms,
      jobs_recent_query_exec_ms: snapshotPack.recent_query_exec_ms,
      jobs_active_query_exec_ms: snapshotPack.active_query_exec_ms,
      outbox_sql_ms: outboxSqlMs,
      outbox_query_exec_ms: outboxPack.timing.query_exec_ms,
      merge_ms: mergeMs,
      total_ms: Date.now() - totalStartedAt,
      carerUid,
      coadminUid: auth.coadminUid,
      recentRowCount: snapshotPack.recentRowCount,
      activeRowCount: snapshotPack.activeRowCount,
      rawRowCount: snapshotPack.rawRowCount,
      mergedRowCount: jobs.length,
      latestOutboxId: outboxPack.latestOutboxId,
    });

    return NextResponse.json({
      jobs,
      snapshotAt: new Date().toISOString(),
      latestOutboxId: outboxPack.latestOutboxId,
      source: 'postgres_snapshot',
    });
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'automation_jobs_snapshot', carerUid, error });
    logSnapshotTiming({
      shared_client: false,
      jobs_pool: 'automationJobsCache',
      client_acquire_ms: clientAcquireMs,
      auth_sql_ms: auth.timing.sql_profile_total_ms,
      jobs_sql_ms: 0,
      outbox_sql_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_snapshot_failed',
      carerUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({
      jobs: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_failed',
    });
  } finally {
    client.release();
  }
}
