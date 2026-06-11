import { Timestamp } from 'firebase/firestore';

import {
  type CarerTask,
  type CarerTaskStatus,
  getEffectiveCarerTaskStatus,
  getVisibleTaskForCarer,
} from '@/features/games/carerTasks';
import { logCarerPageStartup, markCarerPageStartupStreamConnected } from '@/features/carer/carerStartupLogs';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { isPublicCarerTasksSqlReadEnabled } from '@/lib/client/sqlPublicFlags';

export const CARER_TASKS_SQL_READ_ENABLED = isPublicCarerTasksSqlReadEnabled();

type SqlSnapshotTask = {
  id?: string;
  taskId?: string;
  coadminUid?: string;
  playerUid?: string;
  type?: string;
  status?: string;
  automationStatus?: string | null;
  gameName?: string;
  amount?: number | null;
  requestId?: string | null;
  assignedCarerUid?: string | null;
  claimedByUid?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
};

type SqlSnapshotResponse = {
  tasks?: SqlSnapshotTask[];
  latestOutboxId?: number;
  source?: string;
};

type SqlTaskPayload = {
  entityId?: unknown;
  taskId?: unknown;
  coadminUid?: unknown;
  assignedCarerUid?: unknown;
  claimedByUid?: unknown;
  playerUid?: unknown;
  type?: unknown;
  status?: unknown;
  automationStatus?: unknown;
  gameName?: unknown;
  amount?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function carerTaskLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:tasks`;
}

function coadminTaskLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:tasks`;
}

const CARER_TASK_UPSERT_EVENTS = new Set([
  'task.upserted',
  'task.returned_to_pending',
  'task.claimed',
  'recharge_task_create',
  'redeem_task_create',
  'recharge_create',
  'redeem_create',
  'game_request_task_complete',
]);

const GAME_REQUEST_CREATE_EVENTS = new Set(['recharge_create', 'redeem_create']);

const CARER_TASK_REMOVE_EVENTS = new Set([
  'task.tombstoned',
  'task.deleted_from_pending',
  'recharge_task_dismiss',
  'redeem_task_dismiss',
]);

function normalizeTaskType(value: unknown): CarerTask['type'] {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === 'redeem') return 'redeem';
  if (normalized === 'recharge') return 'recharge';
  if (normalized === 'reset_password') return 'reset_password';
  if (normalized === 'recreate_username') return 'recreate_username';
  if (normalized === 'create_game_username') return 'create_game_username';
  return (normalized || 'recharge') as CarerTask['type'];
}

function requestLinkedCarerTaskId(requestId: string) {
  const cleanRequestId = cleanText(requestId);
  if (!cleanRequestId) return '';
  return cleanRequestId.startsWith('request__')
    ? cleanRequestId
    : `request__${cleanRequestId}`;
}

function resolveCarerTaskIdFromEvent(
  event: string,
  payload: SqlTaskPayload,
  rawEntityId: string
): string {
  const explicitTaskId = cleanText(payload.taskId);
  if (explicitTaskId) {
    return explicitTaskId;
  }
  const requestId = cleanText(payload.requestId);
  if (GAME_REQUEST_CREATE_EVENTS.has(event)) {
    return requestLinkedCarerTaskId(requestId || rawEntityId);
  }
  if (requestId && !rawEntityId.startsWith('request__')) {
    return requestLinkedCarerTaskId(requestId);
  }
  return rawEntityId;
}

function enrichPayloadForSseEvent(
  event: string,
  payload: SqlTaskPayload,
  fallbackCoadminUid: string
): SqlTaskPayload {
  const enriched: SqlTaskPayload = { ...payload };
  if (!cleanText(enriched.coadminUid)) {
    enriched.coadminUid = fallbackCoadminUid;
  }
  if (!cleanText(enriched.type)) {
    if (
      event === 'recharge_task_create' ||
      event === 'recharge_create'
    ) {
      enriched.type = 'recharge';
    } else if (
      event === 'redeem_task_create' ||
      event === 'redeem_create'
    ) {
      enriched.type = 'redeem';
    }
  } else {
    enriched.type = normalizeTaskType(enriched.type);
  }
  if (GAME_REQUEST_CREATE_EVENTS.has(event) && !cleanText(enriched.status)) {
    enriched.status = 'pending';
  }
  if (event === 'game_request_task_complete') {
    enriched.status = 'completed';
  }
  const taskId = resolveCarerTaskIdFromEvent(event, enriched, cleanText(enriched.entityId || enriched.taskId));
  if (taskId) {
    enriched.entityId = taskId;
    enriched.taskId = taskId;
  }
  return enriched;
}

function isoToTimestamp(iso: string | null | undefined): Timestamp | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Timestamp.fromMillis(ms);
}

function normalizeCarerTaskStatus(status: unknown): CarerTaskStatus {
  const normalized = cleanText(status).toLowerCase();
  if (
    normalized === 'pending' ||
    normalized === 'in_progress' ||
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'urgent'
  ) {
    return normalized;
  }
  return 'pending';
}

function isSqlEventVisibleToCarer(
  payload: SqlTaskPayload,
  carerUid: string,
  coadminUid: string
) {
  const payloadCoadminUid = cleanText(payload.coadminUid);
  if (payloadCoadminUid && payloadCoadminUid !== coadminUid) {
    return false;
  }

  const assignedCarerUid =
    cleanText(payload.assignedCarerUid) || cleanText(payload.claimedByUid);
  if (assignedCarerUid && assignedCarerUid !== carerUid) {
    return false;
  }

  return true;
}

function mapSnapshotRowToCarerTask(row: SqlSnapshotTask, fallbackCoadminUid: string): CarerTask {
  const id = cleanText(row.id || row.taskId);
  return {
    id,
    coadminUid: cleanText(row.coadminUid) || fallbackCoadminUid,
    type: normalizeTaskType(row.type || 'recharge'),
    playerUid: cleanText(row.playerUid),
    playerUsername: 'Player',
    gameName: cleanText(row.gameName) || 'Unknown Game',
    amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
    requestId: cleanText(row.requestId) || null,
    status: normalizeCarerTaskStatus(row.status),
    assignedCarerUid: cleanText(row.assignedCarerUid) || null,
    assignedCarerUsername: null,
    claimedByUid: cleanText(row.claimedByUid) || null,
    automationStatus: (cleanText(row.automationStatus) || null) as CarerTask['automationStatus'],
    createdAt: isoToTimestamp(row.createdAt),
    completedAt: isoToTimestamp(row.completedAt),
  };
}

function sortTasksByNewest(tasks: CarerTask[]) {
  return [...tasks].sort((left, right) => {
    const leftTime =
      (left.completedAt as Timestamp | null | undefined)?.toMillis?.() ||
      (left.createdAt as Timestamp | null | undefined)?.toMillis?.() ||
      0;
    const rightTime =
      (right.completedAt as Timestamp | null | undefined)?.toMillis?.() ||
      (right.createdAt as Timestamp | null | undefined)?.toMillis?.() ||
      0;
    return rightTime - leftTime;
  });
}

function parseSseBlock(block: string) {
  const lines = block.split('\n');
  let id = 0;
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('id:')) {
      id = Number.parseInt(line.slice(3).trim(), 10) || 0;
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  let payload: SqlTaskPayload = {};
  try {
    payload = JSON.parse(dataLines.join('\n')) as SqlTaskPayload;
  } catch {
    return null;
  }

  const entityId = cleanText(payload.entityId || payload.taskId);
  return {
    id,
    event,
    entityId,
    payload,
    receivedAt: Date.now(),
  };
}

export function attachCarerTaskSqlReadListener(
  carerUid: string,
  coadminUid: string,
  onTasksChange: (tasks: CarerTask[]) => void,
  onFallback: (reason: string) => void
) {
  const cleanCarerUid = cleanText(carerUid);
  const cleanCoadminUid = cleanText(coadminUid);
  let lastEventId = 0;
  let abortController: AbortController | null = null;
  let disposed = false;
  let fellBack = false;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  let refetchInFlight = false;
  const tasksById = new Map<string, CarerTask>();

  const emitTasks = () => {
    if (fellBack || disposed) {
      return;
    }
    onTasksChange(sortTasksByNewest(Array.from(tasksById.values())));
  };

  const shouldRefetchForLiveEvent = (event: string, entityType: string) => {
    if (entityType === 'carer_task') {
      return true;
    }
    if (entityType === 'player_game_request') {
      return (
        CARER_TASK_UPSERT_EVENTS.has(event) ||
        GAME_REQUEST_CREATE_EVENTS.has(event) ||
        CARER_TASK_REMOVE_EVENTS.has(event)
      );
    }
    return (
      CARER_TASK_UPSERT_EVENTS.has(event) ||
      GAME_REQUEST_CREATE_EVENTS.has(event) ||
      CARER_TASK_REMOVE_EVENTS.has(event)
    );
  };

  const loadSnapshot = async (
    headers: Record<string, string>,
    reason: string
  ): Promise<boolean> => {
    console.info('[CARER_TASKS_LIVE_REFETCH_START]', {
      reason,
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      lastEventId,
    });
    const snapshotResponse = await fetch(
      `/api/live/snapshot/carer/${encodeURIComponent(cleanCarerUid)}/tasks`,
      {
        headers,
        cache: 'no-store',
      }
    );
    const snapshot = (await snapshotResponse.json()) as SqlSnapshotResponse;
    const source = cleanText(snapshot.source);
    const ok =
      snapshotResponse.ok &&
      source !== 'postgres_snapshot_failed' &&
      source !== 'postgres_snapshot_unavailable';
    const rows = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    console.info('[CARER_TASKS_LIVE_REFETCH_RESULT]', {
      reason,
      ok,
      status: snapshotResponse.status,
      count: rows.length,
      latestOutboxId: Number(snapshot.latestOutboxId || 0),
      source: source || 'unknown',
    });
    if (!ok) {
      return false;
    }
    lastEventId = Math.max(lastEventId, Number(snapshot.latestOutboxId || 0));
    tasksById.clear();
    for (const row of rows) {
      const mapped = mapSnapshotRowToCarerTask(row, cleanCoadminUid);
      if (!mapped.id) {
        continue;
      }
      applyVisibleTask(mapped, reason);
    }
    emitTasks();
    console.info('[CARER_TASKS_STATE_UPDATED]', {
      reason,
      count: tasksById.size,
      latestOutboxId: lastEventId,
    });
    return true;
  };

  const scheduleLiveRefetch = (reason: string) => {
    if (fellBack || disposed || refetchTimer) {
      return;
    }
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      if (fellBack || disposed || refetchInFlight) {
        return;
      }
      refetchInFlight = true;
      void (async () => {
        try {
          const headers = await getSqlApiReadHeaders(false);
          await loadSnapshot(headers, reason);
        } catch (error) {
          console.info('[CARER_TASKS_LIVE_REFETCH_RESULT]', {
            reason,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          refetchInFlight = false;
        }
      })();
    }, 120);
  };

  const applyVisibleTask = (task: CarerTask, mergeReason: string) => {
    const normalizedStatus = cleanText(task.status).toLowerCase();
    const hadTask = tasksById.has(task.id);
    const previousStatus = hadTask
      ? getEffectiveCarerTaskStatus(tasksById.get(task.id)!)
      : null;

    if (normalizedStatus === 'deleted') {
      tasksById.delete(task.id);
      console.info('[CARER_TASK_LIVE_MERGE]', {
        taskId: task.id,
        status: task.status,
        assignedCarerUid: task.assignedCarerUid || null,
        addedToPending: false,
        addedToInProgress: false,
        removed: true,
        reason: mergeReason || 'status_deleted',
      });
      return;
    }

    const visible = getVisibleTaskForCarer(task, cleanCarerUid);
    const effectiveStatus = visible
      ? getEffectiveCarerTaskStatus(visible)
      : getEffectiveCarerTaskStatus(task);
    const pendingSection = effectiveStatus === 'pending';
    const mineSection = effectiveStatus === 'in_progress';
    const completedSection = effectiveStatus === 'completed';

    console.info('[CARER_TASK_VISIBILITY_FILTER]', {
      taskId: task.id,
      taskType: task.type,
      status: task.status,
      assignedCarerUid: task.assignedCarerUid || null,
      coadminUid: task.coadminUid || cleanCoadminUid,
      deletedAt: null,
      included: Boolean(visible),
      section: visible
        ? pendingSection
          ? 'pending'
          : mineSection
            ? 'mine'
            : completedSection
              ? 'completed'
              : 'other'
        : null,
      reason: visible ? mergeReason : mergeReason || 'not_visible_to_carer',
    });

    if (!visible) {
      tasksById.delete(task.id);
      console.info('[CARER_TASK_LIVE_MERGE]', {
        taskId: task.id,
        status: task.status,
        assignedCarerUid: task.assignedCarerUid || null,
        addedToPending: false,
        addedToInProgress: false,
        removed: hadTask,
        reason: mergeReason || 'not_visible_to_carer',
      });
      return;
    }
    const addedToPending =
      effectiveStatus === 'pending' && (!hadTask || previousStatus !== 'pending');
    const addedToInProgress =
      effectiveStatus === 'in_progress' &&
      (!hadTask || previousStatus !== 'in_progress');

    tasksById.set(task.id, visible);
    console.info('[CARER_TASK_LIVE_MERGE]', {
      taskId: task.id,
      status: visible.status,
      assignedCarerUid: visible.assignedCarerUid || null,
      addedToPending,
      addedToInProgress,
      removed: false,
      reason: mergeReason,
    });
  };

  const consumeSseChunk = (chunk: string, bufferRef: { value: string }) => {
    bufferRef.value += chunk;
    const parts = bufferRef.value.split('\n\n');
    bufferRef.value = parts.pop() || '';

    for (const part of parts) {
      if (!part.trim() || part.trim().startsWith(':')) {
        continue;
      }
      const parsed = parseSseBlock(part);
      if (!parsed) {
        continue;
      }

      console.info('[CARER_LIVE_STREAM_EVENT]', {
        outboxId: parsed.id,
        eventType: parsed.event,
        entityId: parsed.entityId || null,
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
      });

      if (parsed.id > 0) {
        lastEventId = Math.max(lastEventId, parsed.id);
      }

      const enrichedPayload = enrichPayloadForSseEvent(
        parsed.event,
        parsed.payload,
        cleanCoadminUid
      );
      const taskId = parsed.entityId
        ? resolveCarerTaskIdFromEvent(parsed.event, enrichedPayload, parsed.entityId)
        : '';
      const visibleToCarer = taskId
        ? isSqlEventVisibleToCarer(enrichedPayload, cleanCarerUid, cleanCoadminUid)
        : true;
      const entityType =
        parsed.event.startsWith('task.') || parsed.event.endsWith('_task_create')
          ? 'carer_task'
          : GAME_REQUEST_CREATE_EVENTS.has(parsed.event)
            ? 'player_game_request'
            : 'live_event';

      if (shouldRefetchForLiveEvent(parsed.event, entityType)) {
        scheduleLiveRefetch(`live_event:${parsed.event}`);
      }

      if (!parsed.entityId || !taskId) {
        continue;
      }

      const upsertLike =
        CARER_TASK_UPSERT_EVENTS.has(parsed.event) ||
        GAME_REQUEST_CREATE_EVENTS.has(parsed.event);
      const removeLike = CARER_TASK_REMOVE_EVENTS.has(parsed.event);
      const accepted = visibleToCarer && (upsertLike || removeLike);
      const taskType = cleanText(enrichedPayload.type) || null;

      console.info('[CARER_TASK_SSE_EVENT]', {
        channel: null,
        taskId,
        taskType,
        status: cleanText(enrichedPayload.status) || null,
        accepted,
        mergeReason: parsed.event,
      });

      if (taskType === 'recharge' || taskType === 'redeem') {
        const auditChannel = GAME_REQUEST_CREATE_EVENTS.has(parsed.event)
          ? coadminTaskLiveChannel(cleanCoadminUid)
          : carerTaskLiveChannel(cleanCarerUid);
        console.info('[CARER_TASK_SSE_AUDIT]', {
          channel: auditChannel,
          eventType: parsed.event,
          taskId,
          taskType,
          status: cleanText(enrichedPayload.status) || null,
          accepted,
          reason: accepted ? parsed.event : visibleToCarer ? 'event_not_handled' : 'not_visible_to_carer',
        });
      }

      if (!visibleToCarer || !accepted) {
        continue;
      }

      if (removeLike) {
        tasksById.delete(taskId);
        console.info('[CARER_TASK_LIVE_MERGE]', {
          taskId,
          status: cleanText(enrichedPayload.status) || parsed.event,
          assignedCarerUid: cleanText(enrichedPayload.assignedCarerUid) || null,
          addedToPending: false,
          addedToInProgress: false,
          removed: true,
          reason: parsed.event,
        });
        emitTasks();
      }
    }
  };

  const connectStream = async (headers: Record<string, string>) => {
    const streamChannels = [
      carerTaskLiveChannel(cleanCarerUid),
      coadminTaskLiveChannel(cleanCoadminUid),
    ];
    console.info('[CARER_TASK_STREAM_SUBSCRIPTIONS]', {
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      channels: streamChannels,
      includesCoadminPool: true,
      includesCarerAssigned: true,
    });
    const channelList = streamChannels.map(encodeURIComponent).join(',');
    const url = `/api/live/stream?channels=${channelList}&lastEventId=${lastEventId}`;
    const response = await fetch(url, {
      headers,
      signal: abortController?.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) {
      throw new Error(`sse_http_${response.status}`);
    }
    console.info('[CARER_LIVE_STREAM_OPEN]', {
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      channels: streamChannels,
      lastEventId,
      status: response.status,
    });
    markCarerPageStartupStreamConnected('carer_tasks');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const bufferRef = { value: '' };

    while (!disposed && !fellBack) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error('sse_stream_closed');
      }
      consumeSseChunk(decoder.decode(value, { stream: true }), bufferRef);
    }
  };

  const triggerFallback = (reason: string) => {
    if (fellBack || disposed) {
      return;
    }
    fellBack = true;
    abortController?.abort();
    abortController = null;
    console.info('[CARER_TASKS_SQL_READ] fallback_to_firebase reason=%s', reason);
    onFallback(reason);
  };

  const runLiveStreamLoop = async (headers: Record<string, string>) => {
    while (!disposed && !fellBack) {
      try {
        abortController = new AbortController();
        await connectStream(headers);
        if (disposed || fellBack) {
          break;
        }
        console.info('[CARER_LIVE_STREAM_EVENT]', {
          eventType: 'stream_closed',
          carerUid: cleanCarerUid,
          coadminUid: cleanCoadminUid,
          lastEventId,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        if (disposed || fellBack) {
          break;
        }
        console.info('[CARER_LIVE_STREAM_EVENT]', {
          eventType: 'stream_error',
          carerUid: cleanCarerUid,
          coadminUid: cleanCoadminUid,
          error: error instanceof Error ? error.message : String(error),
          lastEventId,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } finally {
        abortController = null;
      }
    }
  };

  const bootstrap = async () => {
    console.info('[CARER_TASKS_SQL_READ] enabled');
    const bootstrapStartedAt = Date.now();
    try {
      const headers = await getSqlApiReadHeaders(false);
      const snapshotStartedAt = Date.now();
      logCarerPageStartup({
        stage: 'tasks_snapshot_start',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
      });
      const snapshotOk = await loadSnapshot(headers, 'bootstrap');
      if (!snapshotOk) {
        logCarerPageStartup({
          stage: 'tasks_snapshot_done',
          ok: false,
          uid: cleanCarerUid,
          role: 'carer',
          durationMs: Date.now() - snapshotStartedAt,
          reason: 'snapshot_load_failed',
        });
        triggerFallback('snapshot_load_failed');
        return;
      }

      logCarerPageStartup({
        stage: 'tasks_snapshot_done',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - snapshotStartedAt,
        extra: {
          count: tasksById.size,
          latestOutboxId: lastEventId,
        },
      });
      console.info(
        '[CARER_TASKS_SQL_READ] snapshot_loaded count=%s latestOutboxId=%s',
        tasksById.size,
        lastEventId
      );

      const sseStartedAt = Date.now();
      await runLiveStreamLoop(headers);
      logCarerPageStartup({
        stage: 'sse_start',
        ok: !fellBack,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - sseStartedAt,
        reason: disposed ? 'disposed' : fellBack ? 'fallback' : 'stream_loop_exited',
        extra: { channel: 'carer_tasks', bootstrapMs: Date.now() - bootstrapStartedAt },
      });
    } catch (error) {
      if (!disposed) {
        const reason =
          error instanceof Error ? error.message : 'bootstrap_or_sse_failed';
        logCarerPageStartup({
          stage: 'tasks_snapshot_done',
          ok: false,
          uid: cleanCarerUid,
          role: 'carer',
          durationMs: Date.now() - bootstrapStartedAt,
          reason,
        });
        triggerFallback(reason);
      }
    }
  };

  void bootstrap();

  return {
    dispose() {
      disposed = true;
      if (refetchTimer) {
        clearTimeout(refetchTimer);
        refetchTimer = null;
      }
      abortController?.abort();
      abortController = null;
      tasksById.clear();
    },
    hasFallenBack() {
      return fellBack;
    },
  };
}
