import type { AutomationUiStatus } from '@/features/automation/automationJobs';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

function carerJobLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:jobs`;
}

function coadminJobLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:jobs`;
}

type ShadowJobPayload = {
  entityId?: unknown;
  jobId?: unknown;
  taskId?: unknown;
  status?: unknown;
  coadminUid?: unknown;
  carerUid?: unknown;
};

type ShadowSnapshotResponse = {
  jobs?: Array<{ jobId?: string; taskId?: string; status?: string }>;
  latestOutboxId?: number;
};

const LIVE_SHADOW_COMPARE_ENABLED =
  String(process.env.NEXT_PUBLIC_LIVE_SHADOW_COMPARE || '').trim() === '1';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function mapJobStatusToUiStatus(status: string): AutomationUiStatus | null {
  const normalized = cleanText(status).toLowerCase();
  if (normalized === 'queued') return 'waiting';
  if (normalized === 'running') return 'running';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'cancelled' || normalized === 'cancelled_requested') return null;
  if (normalized === 'tombstoned') return null;
  return 'failed';
}

function isShadowEventVisibleToCarer(
  payload: ShadowJobPayload,
  carerUid: string,
  coadminUid: string
) {
  const payloadCoadminUid = cleanText(payload.coadminUid);
  if (payloadCoadminUid && payloadCoadminUid !== coadminUid) {
    return false;
  }

  const payloadCarerUid = cleanText(payload.carerUid);
  if (payloadCarerUid && payloadCarerUid !== carerUid) {
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

  let payload: ShadowJobPayload = {};
  try {
    payload = JSON.parse(dataLines.join('\n')) as ShadowJobPayload;
  } catch {
    return null;
  }

  const taskId = cleanText(payload.taskId);
  const entityId = cleanText(payload.entityId || payload.jobId);
  return {
    id,
    event,
    entityId,
    taskId,
    rawStatus: cleanText(payload.status),
    payload,
    receivedAt: Date.now(),
  };
}

export function attachAutomationJobLiveShadowCompare(carerUid: string, coadminUid: string) {
  const cleanCarerUid = cleanText(carerUid);
  const cleanCoadminUid = cleanText(coadminUid);

  if (!LIVE_SHADOW_COMPARE_ENABLED || !cleanCarerUid || !cleanCoadminUid) {
    return {
      reportFirebaseJobSnapshot: (
        _statusByTaskId: Record<string, AutomationUiStatus>,
        _freshJobByTaskId: Record<string, boolean>
      ) => undefined,
      dispose: () => undefined,
    };
  }

  const sseUiStatusByTaskId = new Map<string, { uiStatus: AutomationUiStatus; receivedAt: number }>();
  let lastEventId = 0;
  let abortController: AbortController | null = null;
  let disposed = false;

  const compareAndLog = (
    statusByTaskId: Record<string, AutomationUiStatus>,
    source: 'firebase'
  ) => {
    for (const [taskId, firebaseUiStatus] of Object.entries(statusByTaskId)) {
      const cleanTaskId = cleanText(taskId);
      if (!cleanTaskId) continue;

      const sseEntry = sseUiStatusByTaskId.get(cleanTaskId);
      if (!sseEntry) continue;

      const match = firebaseUiStatus === sseEntry.uiStatus;
      console.info('[LIVE_AUTOMATION_JOBS_SHADOW]', {
        taskId: cleanTaskId,
        firebaseUiStatus,
        sseUiStatus: sseEntry.uiStatus,
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
      if (!parsed?.taskId) continue;

      if (!isShadowEventVisibleToCarer(parsed.payload, cleanCarerUid, cleanCoadminUid)) {
        console.info('[LIVE_AUTOMATION_JOBS_SHADOW]', {
          phase: 'sse_event_filtered',
          taskId: parsed.taskId,
          jobId: parsed.entityId,
          event: parsed.event,
          outboxId: parsed.id,
        });
        continue;
      }

      lastEventId = Math.max(lastEventId, parsed.id);
      const uiStatus = mapJobStatusToUiStatus(parsed.rawStatus);
      if (uiStatus) {
        sseUiStatusByTaskId.set(parsed.taskId, {
          uiStatus,
          receivedAt: parsed.receivedAt,
        });
      }

      console.info('[LIVE_AUTOMATION_JOBS_SHADOW]', {
        phase: 'sse_event',
        taskId: parsed.taskId,
        jobId: parsed.entityId,
        event: parsed.event,
        rawStatus: parsed.rawStatus,
        sseUiStatus: uiStatus,
        outboxId: parsed.id,
      });
    }
  };

  const connectStream = async (headers: Record<string, string>) => {
    const channelList = [
      carerJobLiveChannel(cleanCarerUid),
      coadminJobLiveChannel(cleanCoadminUid),
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
      console.info('[LIVE_AUTOMATION_JOBS_SHADOW]', {
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
        `/api/live/snapshot/carer/${encodeURIComponent(cleanCarerUid)}/jobs`,
        {
          headers,
          cache: 'no-store',
        }
      );
      const snapshot = (await snapshotResponse.json()) as ShadowSnapshotResponse;
      lastEventId = Number(snapshot.latestOutboxId || 0);

      if (Array.isArray(snapshot.jobs)) {
        for (const job of snapshot.jobs) {
          const taskId = cleanText(job.taskId);
          const uiStatus = mapJobStatusToUiStatus(cleanText(job.status));
          if (taskId && uiStatus) {
            sseUiStatusByTaskId.set(taskId, {
              uiStatus,
              receivedAt: Date.now(),
            });
          }
        }
      }

      console.info('[LIVE_AUTOMATION_JOBS_SHADOW]', {
        phase: 'snapshot_loaded',
        carerUid: cleanCarerUid,
        coadminUid: cleanCoadminUid,
        jobCount: Array.isArray(snapshot.jobs) ? snapshot.jobs.length : 0,
        latestOutboxId: lastEventId,
        status: snapshotResponse.status,
        streamChannels: [
          carerJobLiveChannel(cleanCarerUid),
          coadminJobLiveChannel(cleanCoadminUid),
        ],
      });

      abortController = new AbortController();
      await connectStream(headers);
    } catch (error) {
      if (!disposed) {
        console.info('[LIVE_AUTOMATION_JOBS_SHADOW]', {
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
    reportFirebaseJobSnapshot(
      statusByTaskId: Record<string, AutomationUiStatus>,
      _freshJobByTaskId: Record<string, boolean>
    ) {
      compareAndLog(statusByTaskId, 'firebase');
    },
    dispose() {
      disposed = true;
      abortController?.abort();
      abortController = null;
    },
  };
}
