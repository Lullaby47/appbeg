import type { CarerTask } from '@/features/games/carerTasks';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

function carerTaskLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:tasks`;
}

function coadminTaskLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:tasks`;
}

type ShadowTaskPayload = {
  entityId?: unknown;
  taskId?: unknown;
  status?: unknown;
  coadminUid?: unknown;
  assignedCarerUid?: unknown;
  claimedByUid?: unknown;
};

type ShadowSnapshotResponse = {
  tasks?: Array<{ id?: string; status?: string }>;
  latestOutboxId?: number;
};

const LIVE_SHADOW_COMPARE_ENABLED =
  String(process.env.NEXT_PUBLIC_LIVE_SHADOW_COMPARE || '').trim() === '1';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function isShadowEventVisibleToCarer(
  payload: ShadowTaskPayload,
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

  let payload: ShadowTaskPayload = {};
  try {
    payload = JSON.parse(dataLines.join('\n')) as ShadowTaskPayload;
  } catch {
    return null;
  }

  const entityId = cleanText(payload.entityId || payload.taskId);
  return {
    id,
    event,
    entityId,
    status: cleanText(payload.status),
    payload,
    receivedAt: Date.now(),
  };
}

export function attachCarerTaskLiveShadowCompare(carerUid: string, coadminUid: string) {
  const cleanCarerUid = cleanText(carerUid);
  const cleanCoadminUid = cleanText(coadminUid);

  if (!LIVE_SHADOW_COMPARE_ENABLED || !cleanCarerUid || !cleanCoadminUid) {
    return {
      reportFirebaseSnapshot: (_tasks: CarerTask[]) => undefined,
      dispose: () => undefined,
    };
  }

  const sseStatusByEntityId = new Map<string, { status: string; receivedAt: number }>();
  let lastEventId = 0;
  let abortController: AbortController | null = null;
  let disposed = false;

  const compareAndLog = (tasks: CarerTask[], source: 'firebase') => {
    for (const task of tasks) {
      const entityId = cleanText(task.id);
      if (!entityId) continue;

      const sseEntry = sseStatusByEntityId.get(entityId);
      if (!sseEntry) continue;

      const firebaseStatus = cleanText(task.status);
      const match = firebaseStatus === sseEntry.status;
      console.info('[LIVE_CARER_TASKS_SHADOW]', {
        entityId,
        firebaseStatus,
        sseStatus: sseEntry.status,
        match,
        deltaMs: match ? Math.abs(Date.now() - sseEntry.receivedAt) : null,
        source,
      });
    }
  };

  const consumeSseChunk = (chunk: string, bufferRef: { value: string }) => {
    bufferRef.value += chunk;
    const parts = bufferRef.value.split('\n\n');
    bufferRef.value = parts.pop() || '';

    for (const part of parts) {
      if (!part.trim() || part.trim().startsWith(':')) continue;
      const parsed = parseSseBlock(part);
      if (!parsed?.entityId) continue;

      if (!isShadowEventVisibleToCarer(parsed.payload, cleanCarerUid, cleanCoadminUid)) {
        console.info('[LIVE_CARER_TASKS_SHADOW]', {
          phase: 'sse_event_filtered',
          entityId: parsed.entityId,
          event: parsed.event,
          outboxId: parsed.id,
        });
        continue;
      }

      lastEventId = Math.max(lastEventId, parsed.id);
      sseStatusByEntityId.set(parsed.entityId, {
        status: parsed.status,
        receivedAt: parsed.receivedAt,
      });

      console.info('[LIVE_CARER_TASKS_SHADOW]', {
        phase: 'sse_event',
        entityId: parsed.entityId,
        event: parsed.event,
        sseStatus: parsed.status,
        outboxId: parsed.id,
      });
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
      console.info('[LIVE_CARER_TASKS_SHADOW]', {
        phase: 'stream_failed',
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        status: response.status,
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const bufferRef = { value: '' };

    while (!disposed) {
      const { done, value } = await reader.read();
      if (done) break;
      consumeSseChunk(decoder.decode(value, { stream: true }), bufferRef);
    }
  };

  const bootstrap = async () => {
    try {
      const headers = await getFirebaseApiHeaders(false);
      const snapshotResponse = await fetch(
        `/api/live/snapshot/carer/${encodeURIComponent(cleanCarerUid)}/tasks`,
        {
          headers,
          cache: 'no-store',
        }
      );
      const snapshot = (await snapshotResponse.json()) as ShadowSnapshotResponse;
      lastEventId = Number(snapshot.latestOutboxId || 0);

      console.info('[LIVE_CARER_TASKS_SHADOW]', {
        phase: 'snapshot_loaded',
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        taskCount: Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0,
        latestOutboxId: lastEventId,
        status: snapshotResponse.status,
        streamChannels: [
          carerTaskLiveChannel(cleanCarerUid),
          coadminTaskLiveChannel(cleanCoadminUid),
        ],
      });

      abortController = new AbortController();
      await connectStream(headers);
    } catch (error) {
      if (!disposed) {
        console.info('[LIVE_CARER_TASKS_SHADOW]', {
          phase: 'bootstrap_failed',
          carerUid: cleanCarerUid,
          coadminUid: cleanCoadminUid,
          error,
        });
      }
    }
  };
  void bootstrap();

  return {
    reportFirebaseSnapshot(tasks: CarerTask[]) {
      compareAndLog(tasks, 'firebase');
    },
    dispose() {
      disposed = true;
      abortController?.abort();
      abortController = null;
    },
  };
}
