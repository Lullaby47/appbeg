'use client';

import { Timestamp } from 'firebase/firestore';

import type { PlayerCashoutTask } from '@/features/cashouts/playerCashoutTasks';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { subscribePlayerCashoutLiveFromPlayerStream } from '@/features/live/playerRequestSqlRead';

const POLL_MS = 30_000;
const SAFETY_REFETCH_MS = 60_000;
const STARTUP_CASHOUT_CACHE_COOLDOWN_MS = 2_500;
const activeCashoutLiveStreamKeys = new Set<string>();

type CashoutScope = 'player' | 'coadmin' | 'staff' | 'assigned_handler' | 'all';
type CashoutTaskList = 'pending' | 'active' | 'completed';

const CASHOUT_LIVE_EVENTS = [
  'cashout_create',
  'cashout_task_created',
  'cashout_start',
  'cashout_complete',
  'cashout_decline',
] as const;

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function coadminCashoutLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:cashouts`;
}

function playerCashoutLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:cashouts`;
}

function logScopeEventReceived(scope: CashoutScope, eventType: string, payload: Record<string, unknown>) {
  const role = String(getCachedSessionUser()?.role || '').toLowerCase();
  const base = {
    eventType,
    taskId: cleanText(payload.taskId || payload.entityId),
    coadminUid: cleanText(payload.coadminUid),
    playerUid: cleanText(payload.playerUid),
    status: cleanText(payload.status),
    scope,
  };
  if (scope === 'coadmin' || role === 'coadmin') {
    console.info('[COADMIN_CASHOUT_EVENT_RECEIVED]', base);
  }
  if (scope === 'coadmin' || scope === 'all' || scope === 'staff' || role === 'staff') {
    console.info('[STAFF_CASHOUT_EVENT_RECEIVED]', base);
  }
  console.info('[CASHOUT_SSE_EVENT_RECEIVED]', base);
}

function logScopeListAfterEvent(scope: CashoutScope, count: number, reason: string) {
  const role = String(getCachedSessionUser()?.role || '').toLowerCase();
  const base = { scope, count, reason };
  if (scope === 'coadmin' || role === 'coadmin') {
    console.info('[COADMIN_CASHOUT_LIST_AFTER_EVENT]', base);
  }
  if (scope === 'coadmin' || scope === 'all' || scope === 'staff' || role === 'staff') {
    console.info('[STAFF_CASHOUT_LIST_AFTER_EVENT]', base);
  }
  console.info('[CASHOUT_UI_REFETCHED]', base);
}

function isoToTimestamp(iso: string | null | undefined): Timestamp | null {
  if (!iso) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Timestamp.fromMillis(ms) : null;
}

function mapCachedTask(row: Record<string, unknown>): PlayerCashoutTask {
  return {
    id: String(row.id || ''),
    coadminUid: String(row.coadminUid || ''),
    playerUid: String(row.playerUid || ''),
    playerUsername: String(row.playerUsername || ''),
    amountNpr: Number(row.amountNpr || 0),
    paymentDetails: String(row.paymentDetails || ''),
    payoutMethod: (row.payoutMethod as PlayerCashoutTask['payoutMethod']) || null,
    qrImageUrl: String(row.qrImageUrl || '').trim() || null,
    paymentAppName: String(row.paymentAppName || '').trim() || null,
    paymentAppCashTag: String(row.paymentAppCashTag || '').trim() || null,
    paymentAppAccountName: String(row.paymentAppAccountName || '').trim() || null,
    cashDeductedOnRequest:
      typeof row.cashDeductedOnRequest === 'boolean' ? row.cashDeductedOnRequest : undefined,
    declinedByUids: Array.isArray(row.declinedByUids)
      ? row.declinedByUids.map((entry) => String(entry))
      : [],
    status: (String(row.status || 'pending') as PlayerCashoutTask['status']) || 'pending',
    assignedHandlerUid: String(row.assignedHandlerUid || '').trim() || null,
    assignedHandlerUsername: String(row.assignedHandlerUsername || '').trim() || null,
    startedAt: isoToTimestamp(String(row.startedAt || '') || null),
    expiresAt: isoToTimestamp(String(row.expiresAt || '') || null),
    createdAt: isoToTimestamp(String(row.createdAt || '') || null),
    completedAt: isoToTimestamp(String(row.completedAt || '') || null),
  };
}

async function fetchCashoutTasks(
  scope: CashoutScope,
  uid: string,
  limit: number,
  list?: CashoutTaskList
) {
  const params = new URLSearchParams({
    scope,
    limit: String(limit),
  });
  if (scope !== 'all') {
    params.set('uid', uid);
  }
  if ((scope === 'staff' || scope === 'coadmin') && list) {
    params.set('list', list);
  }

  console.info('[CASHOUT_LIST_QUERY]', {
    scope,
    uid: scope === 'all' ? null : uid,
    limit,
  });

  const response = await fetch(`/api/player-cashout-tasks/cache?${params.toString()}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    tasks?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load cashout tasks.');
  }

  const tasks = (payload.tasks || []).map(mapCachedTask);
  console.info('[CASHOUT_LIST_RESULT]', {
    scope,
    uid: scope === 'all' ? null : uid,
    count: tasks.length,
  });
  return tasks;
}

function sanitizePendingCashoutTasks(tasks: PlayerCashoutTask[]): PlayerCashoutTask[] {
  return tasks.filter(
    (task) =>
      String(task.status || '').toLowerCase() === 'pending' &&
      !cleanText(task.assignedHandlerUid)
  );
}

function attachCashoutSqlPoll(input: {
  scope: CashoutScope;
  uid: string;
  limit?: number;
  onChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
  liveChannel?: string | null;
}) {
  logClientFirestoreSkipped('player_cashout_tasks_listener', {
    scope: input.scope,
    uid: input.uid,
    liveChannel: input.liveChannel || null,
  });
  console.info('[POLLER_RETAINED]', {
    pollName: 'player_cashout_tasks',
    scope: input.scope,
    reason: input.liveChannel
      ? 'SSE triggers immediate refetch; safety poll retained for missed events/reconnects'
      : 'no live channel available for this scope',
    safetyRefetchMs: input.liveChannel ? SAFETY_REFETCH_MS : null,
  });

  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyTimer: ReturnType<typeof setInterval> | null = null;
  let eventSource: EventSource | null = null;
  let sharedStreamUnsubscribe: (() => void) | null = null;
  let lastEventId = 0;
  let refetchInFlight = false;
  let refetchQueued = false;
  let lastFetchFinishedAt = 0;
  let activeLiveStreamKey: string | null = null;
  const startedAt = Date.now();

  const isStartupCooldownActive = () =>
    Date.now() - startedAt < STARTUP_CASHOUT_CACHE_COOLDOWN_MS;

  const logCashoutCacheDeduped = (reason: string, detail: string) => {
    console.info('[PLAYER_CASHOUT_CACHE_DEDUPED]', {
      scope: input.scope,
      uid: input.scope === 'all' ? null : input.uid,
      reason,
      detail,
      lastEventId,
      startupAgeMs: Date.now() - startedAt,
    });
  };

  const runPoll = async (reason: string) => {
    if (disposed) {
      return;
    }
    if (
      input.scope === 'player' &&
      typeof document !== 'undefined' &&
      document.hidden &&
      sharedStreamUnsubscribe
    ) {
      if (!disposed) {
        pollTimer = setTimeout(() => {
          void runPoll('poll_interval_hidden_wait');
        }, POLL_MS);
      }
      return;
    }
    if (refetchInFlight) {
      if (isStartupCooldownActive()) {
        logCashoutCacheDeduped(reason, 'in_flight_startup_refetch_suppressed');
        return;
      }
      refetchQueued = true;
      return;
    }
    refetchInFlight = true;
    try {
      const tasks = await fetchCashoutTasks(input.scope, input.uid, input.limit || 50);
      if (!disposed) {
        input.onChange(tasks);
        logScopeListAfterEvent(input.scope, tasks.length, reason);
        console.info('[CASHOUT_UI_UPDATED]', {
          scope: input.scope,
          uid: input.scope === 'all' ? null : input.uid,
          count: tasks.length,
          reason,
        });
      }
    } catch (error) {
      if (!disposed) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      refetchInFlight = false;
      lastFetchFinishedAt = Date.now();
      if (!disposed && refetchQueued) {
        refetchQueued = false;
        if (isStartupCooldownActive()) {
          logCashoutCacheDeduped('queued', 'queued_startup_refetch_suppressed');
          if (!disposed) {
            pollTimer = setTimeout(() => {
              void runPoll('poll_interval');
            }, POLL_MS);
          }
          return;
        }
        void runPoll('queued');
        return;
      }
      if (!disposed) {
        pollTimer = setTimeout(() => {
          void runPoll('poll_interval');
        }, POLL_MS);
      }
    }
  };

  const scheduleImmediateRefetch = (reason: string) => {
    if (disposed) {
      return;
    }
    if (
      isStartupCooldownActive() &&
      lastFetchFinishedAt > 0 &&
      Date.now() - lastFetchFinishedAt < STARTUP_CASHOUT_CACHE_COOLDOWN_MS
    ) {
      logCashoutCacheDeduped(reason, 'recent_startup_fetch_suppressed');
      return;
    }
    console.info('[CASHOUT_LIVE_EVENT_RECEIVED]', {
      scope: input.scope,
      uid: input.scope === 'all' ? null : input.uid,
      reason,
      lastEventId,
    });
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    void runPoll(reason);
  };

  const handleLiveEvent = (eventName: string, rawData: string, outboxId: number) => {
    if (eventName === 'ping') {
      return;
    }
    if (outboxId > 0) {
      lastEventId = Math.max(lastEventId, outboxId);
    }
    try {
      const payload = JSON.parse(rawData) as Record<string, unknown>;
      logScopeEventReceived(input.scope, eventName, payload);
      console.info('[CASHOUT_LIVE_EVENT_RECEIVED]', {
        eventType: eventName,
        taskId: cleanText(payload.taskId || payload.entityId),
        coadminUid: cleanText(payload.coadminUid),
        playerUid: cleanText(payload.playerUid),
        status: cleanText(payload.status),
        outboxId,
      });
    } catch {
      console.info('[CASHOUT_LIVE_EVENT_RECEIVED]', {
        eventType: eventName,
        outboxId,
      });
    }
    scheduleImmediateRefetch(`live:${eventName}`);
  };

  const closeEventSource = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (activeLiveStreamKey) {
      activeCashoutLiveStreamKeys.delete(activeLiveStreamKey);
      activeLiveStreamKey = null;
    }
  };

  const connectEventSource = () => {
    if (!input.liveChannel || disposed) {
      return;
    }

    if (input.scope === 'player') {
      if (sharedStreamUnsubscribe) {
        console.info('[PLAYER_LIVE_STREAM_SINGLETON_REUSED]', {
          playerUid: input.uid,
          subscriber: 'cashout',
          reason: 'already_registered',
        });
        return;
      }
      sharedStreamUnsubscribe = subscribePlayerCashoutLiveFromPlayerStream(input.uid, ({
        eventName,
        rawData,
        outboxId,
      }) => {
        handleLiveEvent(eventName, rawData, outboxId);
      });
      console.info('[PLAYER_LIVE_STREAM_SINGLETON_REUSED]', {
        playerUid: input.uid,
        subscriber: 'cashout',
        channel: input.liveChannel,
      });
      return;
    }

    closeEventSource();
    const params = new URLSearchParams({
      channels: input.liveChannel,
      lastEventId: String(Math.max(0, lastEventId)),
    });
    const appSessionId = cleanText(getLocalAppSessionId());
    if (appSessionId) {
      params.set('appSessionId', appSessionId);
    }
    const url = `/api/live/stream?${params.toString()}`;
    const streamKey = `cashout:${input.scope}:${input.liveChannel}`;
    if (activeCashoutLiveStreamKeys.has(streamKey)) {
      console.info('[PLAYER_SSE_DEDUPED]', {
        streamKey,
        scope: input.scope,
        uid: input.scope === 'all' ? null : input.uid,
        reason: 'cashout_live_stream_already_active',
      });
      return;
    }
    activeCashoutLiveStreamKeys.add(streamKey);
    activeLiveStreamKey = streamKey;
    const source = new EventSource(url);
    eventSource = source;

    source.addEventListener('ping', (ev: Event) => {
      const message = ev as MessageEvent<string>;
      handleLiveEvent('ping', String(message.data || ''), Number(message.lastEventId) || 0);
    });

    for (const eventName of CASHOUT_LIVE_EVENTS) {
      source.addEventListener(eventName, (ev: Event) => {
        const message = ev as MessageEvent<string>;
        handleLiveEvent(
          eventName,
          String(message.data || ''),
          Number(message.lastEventId) || 0
        );
      });
    }

    source.onmessage = (ev: MessageEvent<string>) => {
      handleLiveEvent('message', String(ev.data || ''), Number(ev.lastEventId) || 0);
    };

    source.onerror = () => {
      closeEventSource();
      scheduleImmediateRefetch('sse_error');
    };
  };

  void runPoll('initial');
  connectEventSource();
  safetyTimer = setInterval(() => {
    if (
      input.scope === 'player' &&
      typeof document !== 'undefined' &&
      document.hidden &&
      sharedStreamUnsubscribe
    ) {
      return;
    }
    scheduleImmediateRefetch('safety_interval');
  }, SAFETY_REFETCH_MS);

  return () => {
    disposed = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (safetyTimer) {
      clearInterval(safetyTimer);
      safetyTimer = null;
    }
    closeEventSource();
    sharedStreamUnsubscribe?.();
    sharedStreamUnsubscribe = null;
  };
}

export function attachStaffCashoutLifecyclePoll(input: {
  coadminUid: string;
  limit?: number;
  onPendingChange: (tasks: PlayerCashoutTask[]) => void;
  onActiveChange: (tasks: PlayerCashoutTask[]) => void;
  onCompletedChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}): { dispose: () => void; refetchNow: () => void } {
  return attachScopedCashoutLifecyclePoll({
    scope: 'staff',
    ...input,
  });
}

export function attachCoadminCashoutLifecyclePoll(input: {
  coadminUid: string;
  limit?: number;
  onPendingChange: (tasks: PlayerCashoutTask[]) => void;
  onActiveChange: (tasks: PlayerCashoutTask[]) => void;
  onCompletedChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}): { dispose: () => void; refetchNow: () => void } {
  return attachScopedCashoutLifecyclePoll({
    scope: 'coadmin',
    ...input,
  });
}

function attachScopedCashoutLifecyclePoll(input: {
  scope: 'staff' | 'coadmin';
  coadminUid: string;
  limit?: number;
  onPendingChange: (tasks: PlayerCashoutTask[]) => void;
  onActiveChange: (tasks: PlayerCashoutTask[]) => void;
  onCompletedChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}): { dispose: () => void; refetchNow: () => void } {
  const limit = input.limit || 50;
  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyTimer: ReturnType<typeof setInterval> | null = null;
  let eventSource: EventSource | null = null;
  let lastEventId = 0;
  let refetchInFlight = false;
  let refetchQueued = false;
  const liveChannel = coadminCashoutLiveChannel(input.coadminUid);

  const runPoll = async (reason: string) => {
    if (disposed) {
      return;
    }
    if (refetchInFlight) {
      refetchQueued = true;
      return;
    }
    refetchInFlight = true;
    try {
      const [pending, active, completed] = await Promise.all([
        fetchCashoutTasks(input.scope, input.coadminUid, limit, 'pending'),
        fetchCashoutTasks(input.scope, input.coadminUid, limit, 'active'),
        fetchCashoutTasks(input.scope, input.coadminUid, limit, 'completed'),
      ]);
      if (!disposed) {
        const sanitizedPending = sanitizePendingCashoutTasks(pending);
        input.onPendingChange(sanitizedPending);
        input.onActiveChange(active);
        input.onCompletedChange(completed);
        const loadedLog =
          input.scope === 'staff' ? '[STAFF_COMPLETED_TASKS] loaded' : '[COADMIN_COMPLETED_TASKS] loaded';
        console.info('[STAFF_CASHOUT_TASKS] pendingLoaded', {
          scope: input.scope,
          count: sanitizedPending.length,
          rawCount: pending.length,
          reason,
        });
        console.info('[STAFF_CASHOUT_TASKS] activeLoaded', { scope: input.scope, count: active.length, reason });
        console.info(loadedLog, { scope: input.scope, count: completed.length, reason });
      }
    } catch (error) {
      if (!disposed) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      refetchInFlight = false;
      if (!disposed && refetchQueued) {
        refetchQueued = false;
        void runPoll('queued');
        return;
      }
      if (!disposed) {
        pollTimer = setTimeout(() => {
          void runPoll('poll_interval');
        }, POLL_MS);
      }
    }
  };

  const refetchNow = (reason = 'manual') => {
    if (disposed) {
      return;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    void runPoll(reason);
  };

  const scheduleImmediateRefetch = (reason: string) => {
    if (disposed) {
      return;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    refetchNow(reason);
  };

  const closeEventSource = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const connectEventSource = () => {
    if (disposed) {
      return;
    }
    closeEventSource();
    const params = new URLSearchParams({
      channels: liveChannel,
      lastEventId: String(Math.max(0, lastEventId)),
    });
    const appSessionId = cleanText(getLocalAppSessionId());
    if (appSessionId) {
      params.set('appSessionId', appSessionId);
    }
    const source = new EventSource(`/api/live/stream?${params.toString()}`);
    eventSource = source;

    const handleLiveEvent = (eventName: string, rawData: string, outboxId: number) => {
      if (eventName === 'ping') {
        return;
      }
      if (outboxId > 0) {
        lastEventId = Math.max(lastEventId, outboxId);
      }
      try {
        const payload = JSON.parse(rawData) as Record<string, unknown>;
        logScopeEventReceived(input.scope, eventName, payload);
      } catch {
        // Ignore malformed SSE payloads; still refetch lists.
      }
      scheduleImmediateRefetch(`live:${eventName}`);
    };

    source.addEventListener('ping', (ev: Event) => {
      const message = ev as MessageEvent<string>;
      handleLiveEvent('ping', String(message.data || ''), Number(message.lastEventId) || 0);
    });

    for (const eventName of CASHOUT_LIVE_EVENTS) {
      source.addEventListener(eventName, (ev: Event) => {
        const message = ev as MessageEvent<string>;
        try {
          handleLiveEvent(
            eventName,
            String(message.data || ''),
            Number(message.lastEventId) || 0
          );
        } catch {
          scheduleImmediateRefetch(`live:${eventName}`);
        }
      });
    }

    source.onerror = () => {
      closeEventSource();
      scheduleImmediateRefetch('sse_error');
    };
  };

  void runPoll('initial');
  connectEventSource();
  safetyTimer = setInterval(() => {
    scheduleImmediateRefetch('safety_interval');
  }, SAFETY_REFETCH_MS);

  const dispose = () => {
    disposed = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (safetyTimer) {
      clearInterval(safetyTimer);
      safetyTimer = null;
    }
    closeEventSource();
  };

  return { dispose, refetchNow };
}

export function attachPlayerCashoutTasksSqlPoll(input: {
  scope: CashoutScope;
  uid: string;
  limit?: number;
  onChange: (tasks: PlayerCashoutTask[]) => void;
  onError?: (error: Error) => void;
}) {
  const liveChannel =
    input.scope === 'coadmin' || input.scope === 'staff'
      ? coadminCashoutLiveChannel(input.uid)
      : input.scope === 'player'
        ? playerCashoutLiveChannel(input.uid)
        : null;

  return attachCashoutSqlPoll({
    ...input,
    liveChannel,
  });
}

export function isPlayerCashoutSqlReadEnabled() {
  return isClientSqlReadMode();
}
