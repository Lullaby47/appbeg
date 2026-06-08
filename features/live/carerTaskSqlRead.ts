import { Timestamp } from 'firebase/firestore';

import {
  type CarerTask,
  type CarerTaskStatus,
  getVisibleTaskForCarer,
} from '@/features/games/carerTasks';
import { logCarerPageStartup, markCarerPageStartupStreamConnected } from '@/features/carer/carerStartupLogs';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export const CARER_TASKS_SQL_READ_ENABLED =
  String(process.env.NEXT_PUBLIC_CARER_TASKS_SQL_READ || '').trim() === '1';

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
    type: (cleanText(row.type) || 'recharge') as CarerTask['type'],
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

function mergePayloadIntoCarerTask(
  payload: SqlTaskPayload,
  existing: CarerTask | undefined,
  fallbackCoadminUid: string
): CarerTask {
  const id = cleanText(payload.entityId || payload.taskId || existing?.id);
  const status = cleanText(payload.status);
  return {
    id,
    coadminUid: cleanText(payload.coadminUid) || existing?.coadminUid || fallbackCoadminUid,
    type: (cleanText(payload.type) || existing?.type || 'recharge') as CarerTask['type'],
    playerUid: cleanText(payload.playerUid) || existing?.playerUid || '',
    playerUsername: existing?.playerUsername || 'Player',
    gameName: cleanText(payload.gameName) || existing?.gameName || 'Unknown Game',
    amount:
      payload.amount !== undefined && payload.amount !== null
        ? Number.isFinite(Number(payload.amount))
          ? Number(payload.amount)
          : existing?.amount ?? null
        : existing?.amount ?? null,
    requestId: cleanText(payload.requestId) || existing?.requestId || null,
    status: status ? normalizeCarerTaskStatus(status) : existing?.status || 'pending',
    assignedCarerUid:
      payload.assignedCarerUid !== undefined
        ? cleanText(payload.assignedCarerUid) || null
        : existing?.assignedCarerUid ?? null,
    assignedCarerUsername: existing?.assignedCarerUsername ?? null,
    claimedByUid:
      payload.claimedByUid !== undefined
        ? cleanText(payload.claimedByUid) || null
        : existing?.claimedByUid ?? null,
    automationStatus:
      payload.automationStatus !== undefined
        ? ((cleanText(payload.automationStatus) || null) as CarerTask['automationStatus'])
        : existing?.automationStatus ?? null,
    createdAt: existing?.createdAt ?? isoToTimestamp(cleanText(payload.updatedAt)),
    completedAt: existing?.completedAt ?? null,
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
  const tasksById = new Map<string, CarerTask>();

  const emitTasks = () => {
    if (fellBack || disposed) {
      return;
    }
    onTasksChange(sortTasksByNewest(Array.from(tasksById.values())));
  };

  const applyVisibleTask = (task: CarerTask) => {
    const visible = getVisibleTaskForCarer(task, cleanCarerUid);
    if (!visible) {
      tasksById.delete(task.id);
      return;
    }
    tasksById.set(task.id, visible);
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
      if (!parsed?.entityId) {
        continue;
      }

      if (!isSqlEventVisibleToCarer(parsed.payload, cleanCarerUid, cleanCoadminUid)) {
        continue;
      }

      lastEventId = Math.max(lastEventId, parsed.id);

      if (parsed.event === 'task.tombstoned') {
        tasksById.delete(parsed.entityId);
        console.info(
          '[CARER_TASKS_SQL_READ] sse_event type=%s taskId=%s',
          parsed.event,
          parsed.entityId
        );
        emitTasks();
        continue;
      }

      if (parsed.event === 'task.upserted') {
        const merged = mergePayloadIntoCarerTask(
          parsed.payload,
          tasksById.get(parsed.entityId),
          cleanCoadminUid
        );
        applyVisibleTask(merged);
        console.info(
          '[CARER_TASKS_SQL_READ] sse_event type=%s taskId=%s',
          parsed.event,
          parsed.entityId
        );
        emitTasks();
      }
    }
  };

  const connectStream = async (headers: Record<string, string>) => {
    const channelList = [
      carerTaskLiveChannel(cleanCarerUid),
      coadminTaskLiveChannel(cleanCoadminUid),
    ]
      .map(encodeURIComponent)
      .join(',');
    const url = `/api/live/stream?channels=${channelList}&lastEventId=${lastEventId}`;
    const response = await fetch(url, {
      headers,
      signal: abortController?.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) {
      throw new Error(`sse_http_${response.status}`);
    }
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

  const bootstrap = async () => {
    console.info('[CARER_TASKS_SQL_READ] enabled');
    const bootstrapStartedAt = Date.now();
    try {
      const headers = await getFirebaseApiHeaders(false);
      const snapshotStartedAt = Date.now();
      logCarerPageStartup({
        stage: 'tasks_snapshot_start',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
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
      if (
        !snapshotResponse.ok ||
        source === 'postgres_snapshot_failed' ||
        source === 'postgres_snapshot_unavailable'
      ) {
        logCarerPageStartup({
          stage: 'tasks_snapshot_done',
          ok: false,
          uid: cleanCarerUid,
          role: 'carer',
          durationMs: Date.now() - snapshotStartedAt,
          reason: `snapshot_http_${snapshotResponse.status}_${source || 'unknown'}`,
        });
        triggerFallback(`snapshot_http_${snapshotResponse.status}_${source || 'unknown'}`);
        return;
      }

      lastEventId = Number(snapshot.latestOutboxId || 0);
      tasksById.clear();
      for (const row of Array.isArray(snapshot.tasks) ? snapshot.tasks : []) {
        const mapped = mapSnapshotRowToCarerTask(row, cleanCoadminUid);
        if (!mapped.id) {
          continue;
        }
        applyVisibleTask(mapped);
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
          source: source || 'unknown',
        },
      });
      console.info(
        '[CARER_TASKS_SQL_READ] snapshot_loaded count=%s latestOutboxId=%s source=%s',
        tasksById.size,
        lastEventId,
        source || 'unknown'
      );
      emitTasks();

      abortController = new AbortController();
      const sseStartedAt = Date.now();
      await connectStream(headers);
      logCarerPageStartup({
        stage: 'sse_start',
        ok: !fellBack,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - sseStartedAt,
        reason: fellBack ? 'sse_stream_closed' : null,
        extra: { channel: 'carer_tasks', bootstrapMs: Date.now() - bootstrapStartedAt },
      });
      if (!disposed && !fellBack) {
        triggerFallback('sse_stream_closed');
      }
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
      abortController?.abort();
      abortController = null;
      tasksById.clear();
    },
    hasFallenBack() {
      return fellBack;
    },
  };
}
