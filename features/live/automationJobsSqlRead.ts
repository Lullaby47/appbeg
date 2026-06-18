import {
  isFreshAutomationJobUiSignal,
  mapAutomationJobStatusToUiStatus,
  type AutomationUiStatus,
} from '@/features/automation/automationJobs';
import { logCarerPageStartup, markCarerPageStartupStreamConnected } from '@/features/carer/carerStartupLogs';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';
import {
  buildLiveSnapshotPath,
  parseLiveSnapshotResponse,
} from '@/lib/client/liveSnapshotFetch';
import {
  buildCarerJobStreamKey,
  createLiveStreamClientInstanceId,
  getLiveStreamClientRecentReleaseDelayMs,
  LIVE_STREAM_CLIENT_CLEANUP_DELAY_MS,
  logLiveStreamClientConnect,
  logLiveStreamClientDisconnect,
  logLiveStreamClientReconnect,
  registerLiveStreamClientOwner,
  releaseLiveStreamClientOwner,
} from '@/lib/client/liveStreamClientRegistry';
import { reconnectRecoveryDelayMs, waitMs } from '@/lib/client/snapshotPollJitter';
import { isPublicAutomationJobsSqlReadEnabled } from '@/lib/client/sqlPublicFlags';

export const AUTOMATION_JOBS_SQL_READ_ENABLED = isPublicAutomationJobsSqlReadEnabled();

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
  unchanged?: boolean;
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

const JOB_SNAPSHOT_DEBOUNCE_MS = 120;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

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
  const instanceId = createLiveStreamClientInstanceId('carer_jobs');
  const streamKey = buildCarerJobStreamKey(cleanCarerUid);
  let lastEventId = 0;
  let lastSnapshotOutboxId = 0;
  let abortController: AbortController | null = null;
  let connectGeneration = 0;
  let streamLoopPromise: Promise<void> | null = null;
  let reconnectAttempt = 0;
  let reconnectBackoffMs = INITIAL_RECONNECT_MS;
  let disposed = false;
  let fellBack = false;
  let initialSnapshotLoaded = false;
  let recoveryForceFullUsed = false;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  let refetchInFlight = false;
  let queuedRefetchReason: string | null = null;
  const jobsById = new Map<string, SqlJobRecord>();

  const forceDisposeFromRegistry = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    abortController?.abort();
    abortController = null;
    if (refetchTimer) {
      clearTimeout(refetchTimer);
      refetchTimer = null;
    }
    releaseLiveStreamClientOwner({
      streamType: 'carer_jobs',
      streamKey,
      instanceId,
      reason: 'superseded',
    });
    jobsById.clear();
  };

  registerLiveStreamClientOwner({
    streamType: 'carer_jobs',
    streamKey,
    instanceId,
    reason: 'attach',
    supersede: forceDisposeFromRegistry,
  });

  const emitUiState = () => {
    if (fellBack || disposed) {
      return;
    }
    const next = buildUiStateFromJobs(Array.from(jobsById.values()));
    onChange(next.statusByTaskId, next.freshJobByTaskId);
  };

  const shouldForceFullSnapshot = (reason: string) => {
    if (!initialSnapshotLoaded && reason === 'bootstrap') {
      return true;
    }
    if ((reason === 'sse_error' || /^reconnect_attempt_/i.test(reason)) && !recoveryForceFullUsed) {
      recoveryForceFullUsed = true;
      return true;
    }
    return false;
  };

  const logCursorUpdate = (previousLatestOutboxId: number, newLatestOutboxId: number) => {
    if (previousLatestOutboxId === newLatestOutboxId) {
      return;
    }
    console.info('[CARER_JOB_SNAPSHOT_CURSOR_UPDATED]', {
      previousLatestOutboxId,
      newLatestOutboxId,
    });
  };

  const updateSnapshotCursor = (nextOutboxId: number) => {
    const normalizedNextOutboxId = Math.max(0, Number(nextOutboxId || 0));
    const previousLatestOutboxId = lastSnapshotOutboxId;
    lastSnapshotOutboxId = Math.max(lastSnapshotOutboxId, normalizedNextOutboxId);
    lastEventId = Math.max(lastEventId, lastSnapshotOutboxId);
    logCursorUpdate(previousLatestOutboxId, lastSnapshotOutboxId);
  };

  const queueRefetchAfterInFlight = (reason: string) => {
    queuedRefetchReason = queuedRefetchReason || reason;
    console.info('[CARER_JOB_SNAPSHOT_SKIP]', {
      reason,
      skipReason: 'request_in_flight_queued',
      queuedReason: queuedRefetchReason,
    });
  };

  const scheduleSnapshotRefetch = (reason: string) => {
    if (disposed || fellBack) {
      console.info('[CARER_JOB_SNAPSHOT_SKIP]', {
        reason,
        skipReason: disposed ? 'disposed' : 'fallback_active',
      });
      return;
    }
    if (refetchInFlight) {
      queueRefetchAfterInFlight(reason);
      return;
    }
    if (refetchTimer) {
      console.info('[CARER_JOB_SNAPSHOT_SKIP]', {
        reason,
        skipReason: 'debounce_coalesced',
      });
      return;
    }
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      if (disposed || fellBack || refetchInFlight) {
        console.info('[CARER_JOB_SNAPSHOT_SKIP]', {
          reason,
          skipReason: disposed
            ? 'disposed'
            : fellBack
              ? 'fallback_active'
              : 'request_in_flight',
        });
        return;
      }
      void refetchSnapshotNow(reason);
    }, JOB_SNAPSHOT_DEBOUNCE_MS);
  };

  const flushQueuedRefetch = () => {
    if (disposed || fellBack || refetchInFlight || refetchTimer || !queuedRefetchReason) {
      return;
    }
    const reason = queuedRefetchReason;
    queuedRefetchReason = null;
    scheduleSnapshotRefetch(reason);
  };

  const loadSnapshot = async (
    headers: Record<string, string>,
    reason: string
  ): Promise<boolean> => {
    const requireFull = shouldForceFullSnapshot(reason);
    console.info('[CARER_JOB_SNAPSHOT_REQUEST]', {
      forceFull: requireFull,
      latestOutboxId: requireFull ? null : lastSnapshotOutboxId,
      reason,
    });
    const snapshotResponse = await fetch(
      buildLiveSnapshotPath(
        `/api/live/snapshot/carer/${encodeURIComponent(cleanCarerUid)}/automation-jobs`,
        {
          latestOutboxId: lastSnapshotOutboxId,
          requireFull,
        }
      ),
      {
        headers: {
          ...headers,
          ...(!requireFull ? { 'If-None-Match': `"${lastSnapshotOutboxId}"` } : {}),
        },
        cache: 'no-store',
      }
    );
    const parsed = await parseLiveSnapshotResponse<SqlSnapshotResponse>(snapshotResponse);
    if (parsed.unchanged) {
      updateSnapshotCursor(Number(parsed.snapshot?.latestOutboxId ?? lastSnapshotOutboxId));
      return true;
    }

    const snapshot = parsed.snapshot;
    const source = cleanText(snapshot?.source);
    if (
      !snapshot ||
      !snapshotResponse.ok ||
      source === 'postgres_snapshot_failed' ||
      source === 'postgres_snapshot_unavailable'
    ) {
      return false;
    }

    updateSnapshotCursor(Number(snapshot.latestOutboxId || 0));
    jobsById.clear();
    for (const row of Array.isArray(snapshot.jobs) ? snapshot.jobs : []) {
      const mapped = mapSnapshotRowToJobRecord(row, cleanCarerUid);
      if (!mapped) {
        continue;
      }
      jobsById.set(mapped.jobId, mapped);
    }
    initialSnapshotLoaded = true;
    emitUiState();
    return true;
  };

  const refetchSnapshotNow = async (reason: string): Promise<boolean> => {
    if (disposed || fellBack) {
      console.info('[CARER_JOB_SNAPSHOT_SKIP]', {
        reason,
        skipReason: disposed ? 'disposed' : 'fallback_active',
      });
      return false;
    }
    if (refetchInFlight) {
      queueRefetchAfterInFlight(reason);
      return false;
    }
    refetchInFlight = true;
    try {
      const headers = await getFirebaseApiHeaders(false);
      return await loadSnapshot(headers, reason);
    } finally {
      refetchInFlight = false;
      flushQueuedRefetch();
    }
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
        scheduleSnapshotRefetch(`live_event:${parsed.event}`);
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
        scheduleSnapshotRefetch(`live_event:${parsed.event}`);
      }
    }
  };

  const closeStream = (reason: string) => {
    connectGeneration += 1;
    abortController?.abort();
    abortController = null;
    logLiveStreamClientDisconnect({
      streamType: 'carer_jobs',
      streamKey,
      instanceId,
      reason,
    });
  };

  const connectStream = async (headers: Record<string, string>, connectReason: string) => {
    if (disposed || fellBack) {
      return;
    }

    closeStream('replace_existing');
    await waitMs(
      Math.max(LIVE_STREAM_CLIENT_CLEANUP_DELAY_MS, getLiveStreamClientRecentReleaseDelayMs(streamKey))
    );
    if (disposed || fellBack) {
      return;
    }

    if (disposed || fellBack) {
      return;
    }

    connectGeneration += 1;
    const generation = connectGeneration;
    abortController = new AbortController();

    const channel = encodeURIComponent(carerJobLiveChannel(cleanCarerUid));
    const url = `/api/live/stream?channels=${channel}&lastEventId=${lastEventId}`;
    logLiveStreamClientConnect({
      streamType: 'carer_jobs',
      instanceId,
      reason: connectReason,
      streamKey,
    });

    const response = await fetch(url, {
      headers,
      signal: abortController.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) {
      throw new Error(`sse_http_${response.status}`);
    }
    if (disposed || fellBack || generation !== connectGeneration) {
      return;
    }
    markCarerPageStartupStreamConnected('automation_jobs');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const bufferRef = { value: '' };

    while (!disposed && !fellBack && generation === connectGeneration) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error('sse_stream_closed');
      }
      if (generation !== connectGeneration) {
        return;
      }
      consumeSseChunk(decoder.decode(value, { stream: true }), bufferRef);
    }
  };

  const runLiveStreamLoop = async () => {
    while (!disposed && !fellBack) {
      const connectReason =
        reconnectAttempt === 0 ? 'bootstrap' : `reconnect_attempt_${reconnectAttempt}`;
      if (reconnectAttempt > 0) {
        logLiveStreamClientReconnect({
          streamType: 'carer_jobs',
          instanceId,
          reason: connectReason,
          streamKey,
          extra: {
            backoffMs: reconnectBackoffMs,
            carerUid: cleanCarerUid,
            lastEventId,
          },
        });
      }
      try {
        const headers = await getFirebaseApiHeaders(false);
        if (disposed || fellBack) {
          break;
        }
        await connectStream(headers, connectReason);
        break;
      } catch (error) {
        if (disposed || fellBack) {
          break;
        }
        const aborted =
          error instanceof DOMException && error.name === 'AbortError'
            ? true
            : error instanceof Error && error.message.includes('aborted');
        if (aborted) {
          break;
        }
        closeStream('sse_error');
        reconnectAttempt += 1;
        if (initialSnapshotLoaded) {
          await refetchSnapshotNow('sse_error').catch(() => false);
        }
        await new Promise((resolve) => setTimeout(resolve, reconnectBackoffMs));
        reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_RECONNECT_MS);
        await waitMs(reconnectRecoveryDelayMs());
        await refetchSnapshotNow(`reconnect_attempt_${reconnectAttempt}`).catch(() => false);
        if (reconnectAttempt >= 8) {
          const reason = error instanceof Error ? error.message : 'sse_stream_failed';
          triggerFallback(reason);
          break;
        }
      }
    }
  };

  const startLiveStreamLoop = () => {
    if (streamLoopPromise) {
      return;
    }
    streamLoopPromise = runLiveStreamLoop().finally(() => {
      streamLoopPromise = null;
    });
  };

  const triggerFallback = (reason: string) => {
    if (fellBack || disposed) {
      return;
    }
    fellBack = true;
    closeStream('fallback');
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
      const snapshotOk = await loadSnapshot(headers, 'bootstrap');
      if (!snapshotOk) {
        logCarerPageStartup({
          stage: 'jobs_snapshot_done',
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
        stage: 'jobs_snapshot_done',
        ok: true,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - snapshotStartedAt,
        extra: {
          count: jobsById.size,
          latestOutboxId: lastSnapshotOutboxId,
          source: 'postgres_snapshot',
        },
      });
      console.info(
        '[AUTOMATION_JOBS_SQL_READ] snapshot_loaded count=%s latestOutboxId=%s source=%s',
        jobsById.size,
        lastSnapshotOutboxId,
        'postgres_snapshot'
      );

      abortController = null;
      const sseStartedAt = Date.now();
      startLiveStreamLoop();
      logCarerPageStartup({
        stage: 'sse_start',
        ok: !fellBack,
        uid: cleanCarerUid,
        role: 'carer',
        durationMs: Date.now() - sseStartedAt,
        reason: fellBack ? 'sse_stream_closed' : null,
        extra: { channel: 'automation_jobs', bootstrapMs: Date.now() - bootstrapStartedAt },
      });
    } catch (error) {
      if (!disposed) {
        const reason = error instanceof Error ? error.message : 'bootstrap_or_sse_failed';
        if (initialSnapshotLoaded) {
          await refetchSnapshotNow('sse_error').catch(() => false);
        }
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
      connectGeneration += 1;
      closeStream('dispose');
      releaseLiveStreamClientOwner({
        streamType: 'carer_jobs',
        streamKey,
        instanceId,
        reason: 'dispose',
      });
      if (refetchTimer) {
        clearTimeout(refetchTimer);
        refetchTimer = null;
      }
      jobsById.clear();
    },
    hasFallenBack() {
      return fellBack;
    },
  };
}
