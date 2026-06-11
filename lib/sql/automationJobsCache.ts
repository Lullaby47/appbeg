import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import { emitAutomationJobOutboxEvent } from '@/lib/sql/liveOutbox';
import { getPlayerMirrorPool, getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';

type AutomationJobMirrorRow = {
  jobId: string;
  taskId: string;
  linkedTaskId: string;
  coadminUid: string;
  carerUid: string;
  playerUid: string;
  agentId: string;
  createdByUid: string;
  createdByName: string;
  gameId: string;
  game: string;
  type: string;
  requestType: string;
  status: string;
  claimedStatus: string;
  payload: unknown;
  result: unknown;
  errorMessage: string;
  cancelledReason: string;
  needsManualReview: boolean | null;
  partialSuccess: boolean | null;
  attempts: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  lastHeartbeatAt: string | null;
  ttlExpiresAt: string | null;
  rawFirestoreData: unknown;
};

export type AutomationJobsAcquireContext = {
  context: string;
  route?: string;
  request_id?: string;
};

function shouldLogAutomationJobsPoolAcquire(
  acquireMs: number,
  waitingBefore: number,
  idleBefore: number
) {
  return (
    process.env.SQL_POOL_DEBUG === '1' ||
    acquireMs >= 10 ||
    waitingBefore > 0 ||
    idleBefore === 0
  );
}

export function getAutomationJobsPool() {
  return getPool();
}

export async function acquireAutomationJobsClient(
  acquireContext?: AutomationJobsAcquireContext
) {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const statsBefore = {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
  const acquireStartedAt = Date.now();
  const client = await pool.connect();
  const acquire_ms = Date.now() - acquireStartedAt;
  if (
    shouldLogAutomationJobsPoolAcquire(
      acquire_ms,
      statsBefore.waitingCount,
      statsBefore.idleCount
    )
  ) {
    console.info('[SQL_POOL_ACQUIRE]', {
      name: 'automationJobsCache',
      context: acquireContext?.context ?? 'unspecified',
      acquire_ms,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      max: getPlayerMirrorPoolStats()?.max ?? null,
      request_id: acquireContext?.request_id ?? null,
      route: acquireContext?.route ?? null,
      idle_before: statsBefore.idleCount,
      waiting_before: statsBefore.waitingCount,
    });
  }
  return {
    client,
    pool_acquire_ms: acquire_ms,
  };
}

function getPool() {
  return getPlayerMirrorPool();
}

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object') {
    const maybe = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof maybe.toDate === 'function') return maybe.toDate();
    if (typeof maybe.toMillis === 'function') return new Date(maybe.toMillis());
    if (typeof maybe.seconds === 'number') return new Date(maybe.seconds * 1000);
    if (typeof maybe._seconds === 'number') return new Date(maybe._seconds * 1000);
  }
  return null;
}

function toIsoString(value: unknown): string | null {
  return toDate(value)?.toISOString() || null;
}

function normalizeJson(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    const date = toDate(value);
    if (date) return date.toISOString();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        normalizeJson(child),
      ])
    );
  }
  return value;
}

function boolOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function intOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function nestedObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeAutomationJobForCache(
  jobId: string,
  data: Record<string, unknown>
): AutomationJobMirrorRow {
  const payload = nestedObject(data.payload);
  const originalTask = nestedObject(payload.originalTask);
  const result = data.result === undefined ? null : data.result;
  const type = cleanText(data.type || data.taskType || payload.type || originalTask.type);
  const game = cleanText(
    data.game ||
      data.gameName ||
      payload.game ||
      payload.gameName ||
      originalTask.gameName ||
      originalTask.game
  );

  return {
    jobId: cleanText(jobId),
    taskId: cleanText(data.taskId || payload.taskId || originalTask.id),
    linkedTaskId: cleanText(data.linkedTaskId || payload.linkedTaskId),
    coadminUid: cleanText(data.coadminUid || payload.coadminUid || originalTask.coadminUid),
    carerUid: cleanText(data.carerUid || data.createdByUid),
    playerUid: cleanText(data.playerUid || payload.playerUid || originalTask.playerUid),
    agentId: cleanText(data.agentId),
    createdByUid: cleanText(data.createdByUid || data.carerUid),
    createdByName: cleanText(data.createdByName || data.carerName || data.assignedCarerUsername),
    gameId: cleanText(data.gameId || payload.gameId || originalTask.gameId),
    game,
    type,
    requestType: cleanText(data.requestType || payload.requestType || payload.type || type),
    status: cleanText(data.status),
    claimedStatus: cleanText(data.claimedStatus),
    payload: normalizeJson(data.payload) || null,
    result: normalizeJson(result),
    errorMessage: cleanText(data.error || data.errorMessage),
    cancelledReason: cleanText(data.cancelledReason),
    needsManualReview: boolOrNull(data.needsManualReview),
    partialSuccess: boolOrNull(data.partial_success || data.partialSuccess),
    attempts: intOrNull(data.attempts),
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
    startedAt: toIsoString(data.startedAt),
    completedAt: toIsoString(data.completedAt),
    failedAt: toIsoString(data.failedAt),
    lastHeartbeatAt: toIsoString(data.lastHeartbeatAt),
    ttlExpiresAt: toIsoString(data.ttlExpiresAt),
    rawFirestoreData: normalizeJson(data) || {},
  };
}

export async function mirrorAutomationJobCache(
  jobId: string,
  data: Record<string, unknown>,
  source = 'appbeg'
) {
  const db = getPool();
  if (!db) return false;

  try {
    const row = normalizeAutomationJobForCache(jobId, data);
    if (!row.jobId) throw new Error('Missing automation job id.');

    const incomingSource = cleanText(source) || 'appbeg';
    const incomingUpdatedAtMs = (() => {
      const parsed = Date.parse(row.updatedAt || '');
      return Number.isFinite(parsed) ? parsed : Date.now();
    })();
    const existing = await db.query(
      `
        SELECT source, updated_at, status
        FROM public.automation_jobs_cache
        WHERE job_id = $1
        LIMIT 1
      `,
      [row.jobId]
    );
    if (existing.rows.length) {
      const existingRow = existing.rows[0] as {
        source?: string | null;
        updated_at?: string | null;
        status?: string | null;
      };
      const existingSource = cleanText(existingRow.source);
      const isIncomingFirestoreMirror = !incomingSource.startsWith('authority');
      if (existingSource.startsWith('authority') && isIncomingFirestoreMirror) {
        const existingUpdatedAtMs = (() => {
          const parsed = Date.parse(toIsoString(existingRow.updated_at) || '');
          return Number.isFinite(parsed) ? parsed : 0;
        })();
        if (
          existingUpdatedAtMs &&
          incomingUpdatedAtMs <= existingUpdatedAtMs + 1000 &&
          cleanText(existingRow.status).toLowerCase() === 'cancelled'
        ) {
          console.info('[AUTOMATION_JOB_MIRROR_SKIP_STALE]', {
            jobId: row.jobId,
            existingSource,
            incomingSource,
            existingStatus: cleanText(existingRow.status) || null,
            incomingStatus: cleanText(row.status) || null,
            reason: 'authority_cancelled_row_newer_than_firestore_mirror',
          });
          return false;
        }
      }
    }

    await db.query(
      `
        INSERT INTO public.automation_jobs_cache (
          job_id,
          task_id,
          linked_task_id,
          coadmin_uid,
          carer_uid,
          player_uid,
          agent_id,
          created_by_uid,
          created_by_name,
          game_id,
          game,
          type,
          request_type,
          status,
          claimed_status,
          payload,
          result,
          error_message,
          cancelled_reason,
          needs_manual_review,
          partial_success,
          attempts,
          created_at,
          updated_at,
          started_at,
          completed_at,
          failed_at,
          last_heartbeat_at,
          ttl_expires_at,
          raw_firestore_data,
          source,
          mirrored_at,
          deleted_at
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
          NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''),
          NULLIF($14, ''), NULLIF($15, ''), $16::jsonb, $17::jsonb,
          NULLIF($18, ''), NULLIF($19, ''), $20, $21, $22,
          $23::timestamptz, $24::timestamptz, $25::timestamptz,
          $26::timestamptz, $27::timestamptz, $28::timestamptz,
          $29::timestamptz, $30::jsonb, $31, now(), NULL
        )
        ON CONFLICT (job_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          linked_task_id = EXCLUDED.linked_task_id,
          coadmin_uid = EXCLUDED.coadmin_uid,
          carer_uid = EXCLUDED.carer_uid,
          player_uid = EXCLUDED.player_uid,
          agent_id = EXCLUDED.agent_id,
          created_by_uid = EXCLUDED.created_by_uid,
          created_by_name = EXCLUDED.created_by_name,
          game_id = EXCLUDED.game_id,
          game = EXCLUDED.game,
          type = EXCLUDED.type,
          request_type = EXCLUDED.request_type,
          status = EXCLUDED.status,
          claimed_status = EXCLUDED.claimed_status,
          payload = EXCLUDED.payload,
          result = EXCLUDED.result,
          error_message = EXCLUDED.error_message,
          cancelled_reason = EXCLUDED.cancelled_reason,
          needs_manual_review = EXCLUDED.needs_manual_review,
          partial_success = EXCLUDED.partial_success,
          attempts = EXCLUDED.attempts,
          created_at = COALESCE(public.automation_jobs_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          failed_at = EXCLUDED.failed_at,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at,
          ttl_expires_at = EXCLUDED.ttl_expires_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        row.jobId,
        row.taskId,
        row.linkedTaskId,
        row.coadminUid,
        row.carerUid,
        row.playerUid,
        row.agentId,
        row.createdByUid,
        row.createdByName,
        row.gameId,
        row.game,
        row.type,
        row.requestType,
        row.status,
        row.claimedStatus,
        JSON.stringify(row.payload),
        JSON.stringify(row.result),
        row.errorMessage,
        row.cancelledReason,
        row.needsManualReview,
        row.partialSuccess,
        row.attempts,
        row.createdAt,
        row.updatedAt,
        row.startedAt,
        row.completedAt,
        row.failedAt,
        row.lastHeartbeatAt,
        row.ttlExpiresAt,
        JSON.stringify(row.rawFirestoreData),
        source,
      ]
    );
    console.info('[AUTOMATION_JOBS_CACHE] mirror upsert ok', { jobId: row.jobId });
    void emitAutomationJobOutboxEvent({
      firebaseId: row.jobId,
      taskId: row.taskId,
      coadminUid: row.coadminUid,
      carerUid: row.carerUid,
      createdByUid: row.createdByUid,
      agentId: row.agentId,
      type: row.type || row.requestType,
      status: row.status,
      gameName: row.game,
      updatedAt: row.updatedAt,
      mirroredAt: new Date().toISOString(),
      source,
      eventType: 'job.upserted',
    }).catch(() => undefined);
    return true;
  } catch (error) {
    console.error('[AUTOMATION_JOBS_CACHE] mirror failed', { jobId, error });
    return false;
  }
}

export const upsertAutomationJobCache = mirrorAutomationJobCache;

export async function mirrorAutomationJobSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return mirrorAutomationJobCache(snap.id, (snap.data() || {}) as Record<string, unknown>, source);
}

export async function mirrorAutomationJobById(jobId: string, source = 'appbeg') {
  const cleanJobId = cleanText(jobId);
  if (!cleanJobId) return false;
  try {
    const snap = await adminDb.collection('automation_jobs').doc(cleanJobId).get();
    if (!snap.exists) return false;
    return mirrorAutomationJobSnapshot(snap, source);
  } catch (error) {
    console.error('[AUTOMATION_JOBS_CACHE] mirror failed', { jobId: cleanJobId, error });
    return false;
  }
}

export async function getAutomationJobCacheById(jobId: string) {
  const db = getPool();
  const cleanJobId = cleanText(jobId);
  if (!db || !cleanJobId) return null;

  try {
    const result = await db.query(
      `
        SELECT *
        FROM public.automation_jobs_cache
        WHERE job_id = $1
        LIMIT 1
      `,
      [cleanJobId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[AUTOMATION_JOBS_CACHE] mirror failed', { jobId: cleanJobId, error });
    return null;
  }
}

export async function tombstoneAutomationJobCache(jobId: string, source = 'appbeg') {
  const db = getPool();
  const cleanJobId = cleanText(jobId);
  if (!db || !cleanJobId) return false;

  try {
    let emitContext: {
      taskId?: string;
      coadminUid?: string;
      carerUid?: string;
      createdByUid?: string;
      agentId?: string;
      type?: string;
      status?: string;
      gameName?: string;
    } = {};
    try {
      const existing = await db.query(
        `
          SELECT
            task_id,
            coadmin_uid,
            carer_uid,
            created_by_uid,
            agent_id,
            type,
            request_type,
            status,
            game
          FROM public.automation_jobs_cache
          WHERE job_id = $1
          LIMIT 1
        `,
        [cleanJobId]
      );
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (row) {
        emitContext = {
          taskId: cleanText(row.task_id),
          coadminUid: cleanText(row.coadmin_uid),
          carerUid: cleanText(row.carer_uid),
          createdByUid: cleanText(row.created_by_uid),
          agentId: cleanText(row.agent_id),
          type: cleanText(row.type) || cleanText(row.request_type),
          status: cleanText(row.status),
          gameName: cleanText(row.game),
        };
      }
    } catch {
      // Best-effort lookup for live shadow emit only.
    }

    await db.query(
      `
        INSERT INTO public.automation_jobs_cache (
          job_id,
          raw_firestore_data,
          source,
          mirrored_at,
          deleted_at
        )
        VALUES ($1, '{}'::jsonb, $2, now(), now())
        ON CONFLICT (job_id) DO UPDATE SET
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = now()
      `,
      [cleanJobId, source]
    );
    console.info('[AUTOMATION_JOBS_CACHE] tombstone ok', { jobId: cleanJobId });
    void emitAutomationJobOutboxEvent({
      firebaseId: cleanJobId,
      ...emitContext,
      status: 'tombstoned',
      updatedAt: new Date().toISOString(),
      mirroredAt: new Date().toISOString(),
      source,
      eventType: 'job.tombstoned',
    }).catch(() => undefined);
    return true;
  } catch (error) {
    console.error('[AUTOMATION_JOBS_CACHE] tombstone failed', { jobId: cleanJobId, error });
    return false;
  }
}
