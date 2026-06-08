import {
  isFreshAutomationJobUiSignal,
  mapAutomationJobStatusToUiStatus,
  type AutomationUiStatus,
} from '@/features/automation/automationJobs';
import { logCarerPageStartup, markCarerPageStartupStreamConnected } from '@/features/carer/carerStartupLogs';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export const AUTOMATION_JOBS_SQL_READ_ENABLED =
  String(process.env.NEXT_PUBLIC_AUTOMATION_JOBS_SQL_READ || '').trim() === '1';

type SqlSnapshotJob = {
  id?: string;
  jobId?: string;
  taskId?: string;
  coadminUid?: string;
  carerUid?: string;
  status?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  lastHeartbeatAt?: string | null;
  needsManualReview?: boolean | null;
  errorMessage?: string | null;
};

type SqlSnapshotResponse = {
  jobs?: SqlSnapshotJob[];
  latestOutboxId?: number;
  source?: string;
};

type SqlJobPayload = {
  entityId?: unknown;
  jobId?: unknown;
  taskId?: unknown;
  coadminUid?: unknown;
  carerUid?: unknown;
  status?: unknown;
  updatedAt?: unknown;
};

type SqlJobRecord = {
  jobId: string;
  taskId: string;
  status: string;
  coadminUid: string;
  carerUid: string;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  needsManualReview: boolean | null;
  errorMessage: string | null;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function carerJobLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:jobs`;
}

function isoToMs(iso: string | null | undefined) {
  if (!iso) {
    return 0;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function isSqlEventVisibleToCarer(
  payload: SqlJobPayload,
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

function mapSnapshotRowToJobRecord(row: SqlSnapshotJob, carerUid: string): SqlJobRecord | null {
  const jobId = cleanText(row.jobId || row.id);
  const taskId = cleanText(row.taskId);
  if (!jobId || !taskId) {
    return null;
  }

  return {
    jobId,
    taskId,
    status: cleanText(row.status),
    coadminUid: cleanText(row.coadminUid),
    carerUid: cleanText(row.carerUid) || carerUid,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    startedAt: row.startedAt ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt ?? null,
    needsManualReview:
      typeof row.needsManualReview === 'boolean' ? row.needsManualReview : null,
    errorMessage: cleanText(row.errorMessage) || null,
  };
}

function mergePayloadIntoJobRecord(
  payload: SqlJobPayload,
  existing: SqlJobRecord | undefined,
  carerUid: string
): SqlJobRecord | null {
  const jobId = cleanText(payload.entityId || payload.jobId || existing?.jobId);
  const taskId = cleanText(payload.taskId || existing?.taskId);
  if (!jobId || !taskId) {
    return null;
  }

  const updatedAt = cleanText(payload.updatedAt) || existing?.updatedAt || null;
  return {
    jobId,
    taskId,
    status: cleanText(payload.status) || existing?.status || '',
    coadminUid: cleanText(payload.coadminUid) || existing?.coadminUid || '',
    carerUid: cleanText(payload.carerUid) || existing?.carerUid || carerUid,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
    startedAt: existing?.startedAt ?? null,
    lastHeartbeatAt: existing?.lastHeartbeatAt ?? null,
    needsManualReview: existing?.needsManualReview ?? null,
    errorMessage: existing?.errorMessage ?? null,
  };
}

function buildUiStateFromJobs(jobs: SqlJobRecord[]) {
  const statusByTaskId: Record<string, AutomationUiStatus> = {};
  const freshJobByTaskId: Record<string, boolean> = {};
  const seenTaskIds = new Set<string>();

  const sorted = [...jobs].sort((left, right) => {
    const leftMs = Math.max(isoToMs(left.updatedAt), isoToMs(left.createdAt));
    const rightMs = Math.max(isoToMs(right.updatedAt), isoToMs(right.createdAt));
    return rightMs - leftMs;
  });

  for (const job of sorted) {
    const taskId = cleanText(job.taskId);
    if (!taskId || seenTaskIds.has(taskId)) {
      continue;
    }
    seenTaskIds.add(taskId);

    const mapped = mapAutomationJobStatusToUiStatus(job.status, {
      needsManualReview: job.needsManualReview,
    });
    if (!mapped) {
      continue;
    }

    statusByTaskId[taskId] = mapped;
    freshJobByTaskId[taskId] = isFreshAutomationJobUiSignal({
      status: job.status,
      heartbeatMs: Math.max(
        isoToMs(job.lastHeartbeatAt),
        isoToMs(job.updatedAt),
        isoToMs(job.startedAt),
        isoToMs(job.createdAt)
      ),
      hasHeartbeat: Boolean(isoToMs(job.lastHeartbeatAt)),
      data: {
        error: job.errorMessage,
        updatedAt: job.updatedAt,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
      },
    });
  }

  return { statusByTaskId, freshJobByTaskId };
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

  let payload: SqlJobPayload = {};
  try {
    payload = JSON.parse(dataLines.join('\n')) as SqlJobPayload;
  } catch {
    return null;
  }

  const entityId = cleanText(payload.entityId || payload.jobId);
  return {
    id,
    event,
    entityId,
    payload,
    receivedAt: Date.now(),
  };
}

export function attachAutomationJobsSqlReadListener(
  carerUid: string,
  coadminUid: string,
  onChange: (
    statusByTaskId: Record<string, AutomationUiStatus>,
    freshJobByTaskId: Record<string, boolean>
  ) => void,
  onFallback: (reason: string) => void
) {
  const cleanCarerUid = cleanText(carerUid);
  const cleanCoadminUid = cleanText(coadminUid);
  let lastEventId = 0;
  let abortController: AbortController | null = null;
  let disposed = false;
  let fellBack = false;
  const jobsById = new Map<string, SqlJobRecord>();

  const emitUiState = () => {
    if (fellBack || disposed) {
      return;
    }
    const next = buildUiStateFromJobs(Array.from(jobsById.values()));
    onChange(next.statusByTaskId, next.freshJobByTaskId);
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

      if (parsed.event === 'job.tombstoned') {
        jobsById.delete(parsed.entityId);
        console.info(
          '[AUTOMATION_JOBS_SQL_READ] sse_event type=%s jobId=%s',
          parsed.event,
          parsed.entityId
        );
        emitUiState();
        continue;
      }

      if (parsed.event === 'job.upserted') {
        const merged = mergePayloadIntoJobRecord(
          parsed.payload,
          jobsById.get(parsed.entityId),
          cleanCarerUid
        );
        if (merged) {
          jobsById.set(merged.jobId, merged);
        }
        console.info(
          '[AUTOMATION_JOBS_SQL_READ] sse_event type=%s jobId=%s',
          parsed.event,
          parsed.entityId
        );
        emitUiState();
      }
    }
  };

  const connectStream = async (headers: Record<string, string>) => {
    const channel = encodeURIComponent(carerJobLiveChannel(cleanCarerUid));
    const url = `/api/live/stream?channels=${channel}&lastEventId=${lastEventId}`;
    const response = await fetch(url, {
      headers,
      signal: abortController?.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) {
      throw new Error(`sse_http_${response.status}`);
    }
    markCarerPageStartupStreamConnected('automation_jobs');

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
    console.info('[AUTOMATION_JOBS_SQL_READ] fallback_to_firebase reason=%s', reason);
    onFallback(reason);
  };

  const bootstrap = async () => {
    console.info('[AUTOMATION_JOBS_SQL_READ] enabled');
    const bootstrapStartedAt = Date.now();
    try {
      const headers = await getFirebaseApiHeaders(false);
      const snapshotStartedAt = Date.now();
      logCarerPageStartup({
        stage: 'jobs_snapshot_start',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
      });
      const snapshotResponse = await fetch(
        `/api/live/snapshot/carer/${encodeURIComponent(cleanCarerUid)}/automation-jobs`,
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
          stage: 'jobs_snapshot_done',
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
      jobsById.clear();
      for (const row of Array.isArray(snapshot.jobs) ? snapshot.jobs : []) {
        const mapped = mapSnapshotRowToJobRecord(row, cleanCarerUid);
        if (!mapped) {
          continue;
        }
        jobsById.set(mapped.jobId, mapped);
      }

      logCarerPageStartup({
        stage: 'jobs_snapshot_done',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - snapshotStartedAt,
        extra: {
          count: jobsById.size,
          latestOutboxId: lastEventId,
          source: source || 'unknown',
        },
      });
      console.info(
        '[AUTOMATION_JOBS_SQL_READ] snapshot_loaded count=%s latestOutboxId=%s source=%s',
        jobsById.size,
        lastEventId,
        source || 'unknown'
      );
      emitUiState();

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
        extra: { channel: 'automation_jobs', bootstrapMs: Date.now() - bootstrapStartedAt },
      });
      if (!disposed && !fellBack) {
        triggerFallback('sse_stream_closed');
      }
    } catch (error) {
      if (!disposed) {
        const reason = error instanceof Error ? error.message : 'bootstrap_or_sse_failed';
        logCarerPageStartup({
          stage: 'jobs_snapshot_done',
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
      jobsById.clear();
    },
    hasFallenBack() {
      return fellBack;
    },
  };
}
