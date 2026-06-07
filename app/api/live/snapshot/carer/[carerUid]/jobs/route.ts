import { NextResponse } from 'next/server';

import { apiError, requireCarerOwnedLiveAuth } from '@/lib/firebase/apiAuth';
import { carerJobLiveChannel, getLatestOutboxIdForChannels } from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

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

const RECOMMENDED_SNAPSHOT_INDEXES = [
  'automation_jobs_cache(created_by_uid, created_at DESC) WHERE deleted_at IS NULL',
  'automation_jobs_cache(carer_uid, created_at DESC) WHERE deleted_at IS NULL',
  'automation_jobs_cache(created_by_uid, status, updated_at DESC) WHERE deleted_at IS NULL',
  'live_outbox(channel, outbox_id) WHERE deleted_at IS NULL',
];

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

async function fetchSnapshotRowsParallel(
  db: NonNullable<ReturnType<typeof getPlayerMirrorPool>>,
  carerUid: string
) {
  const startedAt = Date.now();
  const [recentResult, activeResult] = await Promise.all([
    db.query(
      `
        SELECT *
        FROM public.automation_jobs_cache
        WHERE deleted_at IS NULL
          AND (created_by_uid = $1 OR carer_uid = $1)
        ORDER BY created_at DESC NULLS LAST
        LIMIT $2
      `,
      [carerUid, AUTOMATION_JOB_HISTORY_LIMIT]
    ),
    db.query(
      `
        SELECT *
        FROM public.automation_jobs_cache
        WHERE deleted_at IS NULL
          AND (created_by_uid = $1 OR carer_uid = $1)
          AND status = ANY($2::text[])
        ORDER BY updated_at DESC NULLS LAST
      `,
      [carerUid, AUTOMATION_JOB_ACTIVE_STATUSES]
    ),
  ]);

  const merged = new Map<string, Record<string, unknown>>();
  for (const row of [...recentResult.rows, ...activeResult.rows]) {
    const jobId = cleanText((row as Record<string, unknown>).job_id);
    if (jobId) {
      merged.set(jobId, row as Record<string, unknown>);
    }
  }

  return {
    rows: Array.from(merged.values()),
    durationMs: Date.now() - startedAt,
    recentRowCount: recentResult.rows.length,
    activeRowCount: activeResult.rows.length,
    rawRowCount: merged.size,
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
      sql_jobs_ms: 0,
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
      auth_ms: auth.timing.auth_ms,
      sql_jobs_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'auth_response',
      carerUid,
    });
    return auth.response;
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    logSnapshotTiming({
      auth_ms: auth.timing.auth_ms,
      sql_jobs_ms: 0,
      sql_latest_outbox_ms: 0,
      merge_ms: 0,
      total_ms: Date.now() - totalStartedAt,
      reason: 'postgres_unavailable',
      carerUid,
    });
    return NextResponse.json({
      jobs: [],
      snapshotAt: new Date().toISOString(),
      latestOutboxId: 0,
      source: 'postgres_snapshot_unavailable',
    });
  }

  try {
    const channel = carerJobLiveChannel(carerUid);

    const sqlJobsStartedAt = Date.now();
    const sqlOutboxStartedAt = Date.now();
    const [snapshotPack, outboxPack] = await Promise.all([
      fetchSnapshotRowsParallel(db, carerUid).then((result) => ({
        ...result,
        durationMs: Date.now() - sqlJobsStartedAt,
      })),
      getLatestOutboxIdForChannels([channel]).then((outbox) => ({
        latestOutboxId: outbox.latestOutboxId,
        durationMs: Date.now() - sqlOutboxStartedAt,
      })),
    ]);

    const mergeStartedAt = Date.now();
    const jobs = sortByNewest(snapshotPack.rows.map(mapSnapshotRow).filter((row) => row.id));
    const mergeMs = Date.now() - mergeStartedAt;

    logSnapshotTiming({
      auth_ms: auth.timing.auth_ms,
      sql_jobs_ms: snapshotPack.durationMs,
      sql_latest_outbox_ms: outboxPack.durationMs,
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
      auth_ms: auth.timing.auth_ms,
      sql_jobs_ms: 0,
      sql_latest_outbox_ms: 0,
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
  }
}
