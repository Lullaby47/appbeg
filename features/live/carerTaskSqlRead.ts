import { Timestamp } from 'firebase/firestore';

import {
  type CarerTask,
  type CarerTaskStatus,
  getEffectiveCarerTaskStatus,
  getVisibleTaskForCarer,
} from '@/features/games/carerTasks';
import { logCarerPageStartup, markCarerPageStartupStreamConnected } from '@/features/carer/carerStartupLogs';
import { getLocalAppSessionId } from '@/features/auth/appSession';
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

const CARER_TASK_IMMEDIATE_REFETCH_EVENTS = new Set([
  'task.dismissed',
  'job.dismissed',
  'task.completed',
  'game_request_task_complete',
  'recharge_dismiss',
]);

const ALL_LIVE_TASK_SSE_EVENTS = Array.from(
  new Set([
    ...CARER_TASK_UPSERT_EVENTS,
    ...CARER_TASK_REMOVE_EVENTS,
    ...GAME_REQUEST_CREATE_EVENTS,
    'game_request_task_complete',
  ])
);

const SAFETY_REFETCH_MS = 45_000;
const STALL_TIMEOUT_MS = 90_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

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

export function attachCarerTaskSqlReadListener(
  carerUid: string,
  coadminUid: string,
  onTasksChange: (tasks: CarerTask[]) => void,
  onFallback: (reason: string) => void
) {
  const cleanCarerUid = cleanText(carerUid);
  const cleanCoadminUid = cleanText(coadminUid);
  let lastEventId = 0;
  let eventSource: EventSource | null = null;
  let disposed = false;
  let fellBack = false;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  let refetchInFlight = false;
  let reconnectAttempt = 0;
  let reconnectBackoffMs = INITIAL_RECONNECT_MS;
  let lastSseActivityAt = Date.now();
  let safetyRefetchTimer: ReturnType<typeof setInterval> | null = null;
  let stallWatchTimer: ReturnType<typeof setInterval> | null = null;
  let streamConnectResolve: (() => void) | null = null;
  const tasksById = new Map<string, CarerTask>();
  const streamChannels = [
    carerTaskLiveChannel(cleanCarerUid),
    coadminTaskLiveChannel(cleanCoadminUid),
  ];

  const emitTasks = (reason = 'live_merge') => {
    if (fellBack || disposed) {
      return;
    }
    const nextTasks = sortTasksByNewest(Array.from(tasksById.values()));
    console.info('[CARER_TASKS_STATE_UPDATED]', {
      reason,
      count: nextTasks.length,
      latestOutboxId: lastEventId,
      pendingCount: nextTasks.filter((task) => cleanText(task.status).toLowerCase() === 'pending')
        .length,
      inProgressCount: nextTasks.filter(
        (task) => cleanText(task.status).toLowerCase() === 'in_progress'
      ).length,
    });
    onTasksChange(nextTasks);
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
    emitTasks(reason);
    return true;
  };

  const refetchSnapshotNow = async (
    reason: string,
    priority = false
  ): Promise<boolean> => {
    if (fellBack || disposed) {
      return false;
    }
    if (refetchTimer) {
      clearTimeout(refetchTimer);
      refetchTimer = null;
    }
    if (refetchInFlight) {
      if (!priority) {
        return false;
      }
      for (let attempt = 0; attempt < 50 && refetchInFlight; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (refetchInFlight) {
        return false;
      }
    }
    refetchInFlight = true;
    try {
      const headers = await getSqlApiReadHeaders(false);
      return await loadSnapshot(headers, reason);
    } catch (error) {
      console.info('[CARER_TASKS_LIVE_REFETCH_RESULT]', {
        reason,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      refetchInFlight = false;
    }
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

  const buildStreamUrl = () => {
    const appSessionId = cleanText(getLocalAppSessionId());
    const params = new URLSearchParams({
      channels: streamChannels.join(','),
      lastEventId: String(Math.max(0, lastEventId)),
    });
    if (appSessionId) {
      params.set('appSessionId', appSessionId);
    }
    return `/api/live/stream?${params.toString()}`;
  };

  const closeEventSource = (reason: string) => {
    if (!eventSource) {
      return;
    }
    const readyState = eventSource.readyState;
    eventSource.close();
    eventSource = null;
    console.info('[CARER_LIVE_STREAM_RECONNECT]', {
      phase: 'close',
      reason,
      readyState,
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      lastEventId,
    });
    streamConnectResolve?.();
    streamConnectResolve = null;
  };

  const handleStreamMessage = (eventName: string, rawData: string, outboxId: number) => {
    lastSseActivityAt = Date.now();

    if (eventName === 'ping') {
      let pingPayload: Record<string, unknown> = {};
      try {
        pingPayload = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        pingPayload = {};
      }
      console.info('[CARER_LIVE_STREAM_PING]', {
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        lastEventId,
        now: pingPayload.now || null,
        channels: pingPayload.channels || streamChannels,
      });
      return;
    }

    let payload: SqlTaskPayload = {};
    try {
      payload = JSON.parse(rawData) as SqlTaskPayload;
    } catch {
      return;
    }

    const entityId = cleanText(payload.entityId || payload.taskId);
    console.info('[CARER_LIVE_STREAM_EVENT]', {
      outboxId,
      eventType: eventName,
      entityId: entityId || null,
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
    });

    if (outboxId > 0) {
      lastEventId = Math.max(lastEventId, outboxId);
    }

    const enrichedPayload = enrichPayloadForSseEvent(eventName, payload, cleanCoadminUid);
    const taskId = entityId
      ? resolveCarerTaskIdFromEvent(eventName, enrichedPayload, entityId)
      : '';
    const entityType =
      eventName.startsWith('task.') || eventName.endsWith('_task_create')
        ? 'carer_task'
        : GAME_REQUEST_CREATE_EVENTS.has(eventName)
          ? 'player_game_request'
          : 'live_event';

    if (shouldRefetchForLiveEvent(eventName, entityType)) {
      if (
        eventName === 'task.returned_to_pending' ||
        CARER_TASK_IMMEDIATE_REFETCH_EVENTS.has(eventName)
      ) {
        void refetchSnapshotNow(`live_event:${eventName}`, true);
      } else {
        scheduleLiveRefetch(`live_event:${eventName}`);
      }
    }

    if (!entityId || !taskId) {
      return;
    }

    const visibleToCarer = isSqlEventVisibleToCarer(enrichedPayload, cleanCarerUid, cleanCoadminUid);
    const upsertLike =
      CARER_TASK_UPSERT_EVENTS.has(eventName) || GAME_REQUEST_CREATE_EVENTS.has(eventName);
    const removeLike = CARER_TASK_REMOVE_EVENTS.has(eventName);
    const accepted = visibleToCarer && (upsertLike || removeLike);

    if (!visibleToCarer || !accepted) {
      return;
    }

    if (removeLike) {
      tasksById.delete(taskId);
      emitTasks(`live_event:${eventName}`);
    }
  };

  const connectEventSource = () =>
    new Promise<void>((resolve) => {
      if (disposed || fellBack) {
        resolve();
        return;
      }

      closeEventSource('replace_existing');
      streamConnectResolve = resolve;

      const url = buildStreamUrl();
      console.info('[CARER_TASK_STREAM_SUBSCRIPTIONS]', {
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        channels: streamChannels,
        lastEventId,
        url,
      });

      const source = new EventSource(url);
      eventSource = source;

      source.onopen = () => {
        lastSseActivityAt = Date.now();
        reconnectAttempt = 0;
        reconnectBackoffMs = INITIAL_RECONNECT_MS;
        console.info('[CARER_LIVE_STREAM_OPEN]', {
          carerUid: cleanCarerUid,
          coadminUid: cleanCoadminUid,
          channels: streamChannels,
          lastEventId,
          readyState: source.readyState,
        });
        markCarerPageStartupStreamConnected('carer_tasks');
      };

      source.addEventListener('ping', (ev: Event) => {
        const message = ev as MessageEvent<string>;
        handleStreamMessage('ping', String(message.data || ''), Number(message.lastEventId) || 0);
      });

      for (const eventName of ALL_LIVE_TASK_SSE_EVENTS) {
        source.addEventListener(eventName, (ev: Event) => {
          const message = ev as MessageEvent<string>;
          handleStreamMessage(
            eventName,
            String(message.data || ''),
            Number(message.lastEventId) || 0
          );
        });
      }

      source.onmessage = (ev: MessageEvent<string>) => {
        handleStreamMessage('message', String(ev.data || ''), Number(ev.lastEventId) || 0);
      };

      source.onerror = () => {
        console.info('[CARER_LIVE_STREAM_ERROR]', {
          carerUid: cleanCarerUid,
          coadminUid: cleanCoadminUid,
          readyState: source.readyState,
          lastEventId,
          idleMs: Date.now() - lastSseActivityAt,
        });
        closeEventSource('sse_error');
        void refetchSnapshotNow('sse_error', true).finally(() => {
          resolve();
        });
      };
    });

  const runSafetyRefetch = () => {
    if (disposed || fellBack) {
      return;
    }
    console.info('[CARER_TASKS_SAFETY_REFETCH]', {
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      lastEventId,
      idleMs: Date.now() - lastSseActivityAt,
    });
    void refetchSnapshotNow('safety_interval', true);
  };

  const checkStreamStall = () => {
    if (disposed || fellBack || !eventSource) {
      return;
    }
    const idleMs = Date.now() - lastSseActivityAt;
    if (idleMs < STALL_TIMEOUT_MS) {
      return;
    }
    console.info('[CARER_LIVE_STREAM_ERROR]', {
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      reason: 'stall_timeout',
      idleMs,
      lastEventId,
    });
    closeEventSource('stall_timeout');
    void refetchSnapshotNow('stall_timeout', true).then(() => {
      console.info('[CARER_LIVE_STREAM_RECONNECT]', {
        phase: 'stall_recovery',
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        lastEventId,
      });
    });
  };

  const handleVisibilityRefresh = () => {
    if (disposed || fellBack || document.visibilityState !== 'visible') {
      return;
    }
    console.info('[CARER_TASKS_VISIBILITY_REFETCH]', {
      carerUid: cleanCarerUid,
      coadminUid: cleanCoadminUid,
      lastEventId,
    });
    reconnectAttempt = 0;
    reconnectBackoffMs = INITIAL_RECONNECT_MS;
    closeEventSource('visibility_refresh');
    void refetchSnapshotNow('visibility', true).then(() => {
      console.info('[CARER_LIVE_STREAM_RECONNECT]', {
        phase: 'visibility',
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        lastEventId,
      });
    });
  };

  const runLiveStreamLoop = async () => {
    while (!disposed && !fellBack) {
      await connectEventSource();
      if (disposed || fellBack) {
        break;
      }
      reconnectAttempt += 1;
      console.info('[CARER_LIVE_STREAM_RECONNECT]', {
        phase: 'backoff',
        attempt: reconnectAttempt,
        backoffMs: reconnectBackoffMs,
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        lastEventId,
      });
      await new Promise((resolve) => setTimeout(resolve, reconnectBackoffMs));
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_RECONNECT_MS);
      await refetchSnapshotNow(`reconnect_attempt_${reconnectAttempt}`, true);
    }
  };

  const startMaintenanceTimers = () => {
    if (typeof window === 'undefined') {
      return;
    }
    safetyRefetchTimer = setInterval(runSafetyRefetch, SAFETY_REFETCH_MS);
    stallWatchTimer = setInterval(checkStreamStall, 15_000);
    document.addEventListener('visibilitychange', handleVisibilityRefresh);
    window.addEventListener('focus', handleVisibilityRefresh);
  };

  const stopMaintenanceTimers = () => {
    if (safetyRefetchTimer) {
      clearInterval(safetyRefetchTimer);
      safetyRefetchTimer = null;
    }
    if (stallWatchTimer) {
      clearInterval(stallWatchTimer);
      stallWatchTimer = null;
    }
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityRefresh);
      window.removeEventListener('focus', handleVisibilityRefresh);
    }
  };

  const triggerFallback = (reason: string) => {
    if (fellBack || disposed) {
      return;
    }
    fellBack = true;
    stopMaintenanceTimers();
    closeEventSource('fallback');
    console.info('[CARER_TASKS_SQL_READ] fallback_to_firebase reason=%s', reason);
    onFallback(reason);
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

      lastSseActivityAt = Date.now();
      startMaintenanceTimers();
      void runLiveStreamLoop();

      logCarerPageStartup({
        stage: 'sse_start',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - bootstrapStartedAt,
        extra: { channel: 'carer_tasks', transport: 'eventsource' },
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
      stopMaintenanceTimers();
      if (refetchTimer) {
        clearTimeout(refetchTimer);
        refetchTimer = null;
      }
      closeEventSource('dispose');
      tasksById.clear();
    },
    hasFallenBack() {
      return fellBack;
    },
  };
}
