import { Timestamp } from 'firebase/firestore';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import {
  type PlayerGameRequest,
  type PlayerGameRequestStatus,
  type PlayerGameRequestType,
  sortPlayerGameRequestsByNewest,
} from '@/features/games/playerGameRequests';
import { getPlayerApiHeaders } from '@/features/auth/playerSession';
import { checkPlayerPollRole } from '@/lib/client/playerPollGuard';
import {
  handleStalePlayerFetchError,
  isPlayerSessionStale,
  registerPlayerRuntimeStopper,
} from '@/lib/client/playerStaleSession';
import { LIVE_STREAM_DISABLED } from '@/features/live/liveStreamFlags';
import { isPublicPlayerRequestsSqlReadEnabled } from '@/lib/client/sqlPublicFlags';

export const PLAYER_REQUESTS_SQL_READ_ENABLED = isPublicPlayerRequestsSqlReadEnabled();

type SqlSnapshotRequest = {
  id?: string;
  playerUid?: string;
  gameName?: string;
  type?: string;
  status?: string;
  amount?: number | null;
  baseAmount?: number | null;
  pokeMessage?: string | null;
  dismissReasonCode?: string | null;
  dismissReasonMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  pokedAt?: string | null;
};

const PLAYER_IMMEDIATE_REFETCH_EVENTS = new Set([
  'recharge_dismiss',
  'recharge_completed',
  'redeem_completed',
  'request.completed',
  'game_request_complete',
  'player_message',
  'balance_update',
  'request.upserted',
  'request.dismissed',
  'task.dismissed',
]);

const PLAYER_LIVE_SSE_EVENTS = [
  'recharge_dismiss',
  'recharge_completed',
  'redeem_completed',
  'request.completed',
  'game_request_complete',
  'player_message',
  'balance_update',
  'request.upserted',
  'request.tombstoned',
  'recharge_create',
  'redeem_create',
  'request.dismissed',
  'task.dismissed',
] as const;

export const PLAYER_RECHARGE_SUCCESS_MESSAGE = 'Your game is recharged. Enjoy!';

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 15_000;
const SAFETY_REFETCH_MS = 30_000;
const STALL_TIMEOUT_MS = 90_000;

type SqlSnapshotResponse = {
  requests?: SqlSnapshotRequest[];
  latestOutboxId?: number;
  source?: string;
};

type SqlRequestPayload = {
  entityId?: unknown;
  requestId?: unknown;
  playerUid?: unknown;
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  pokeMessage?: unknown;
  playerMessage?: unknown;
  dismissReasonCode?: unknown;
  dismissReasonMessage?: unknown;
  refunded?: unknown;
  updatedAt?: unknown;
};

export type PlayerRechargeDismissLiveEvent = {
  requestId: string;
  playerUid: string;
  type: PlayerGameRequestType;
  status: PlayerGameRequestStatus;
  pokeMessage: string | null;
  dismissReasonCode: string | null;
  dismissReasonMessage: string | null;
  refunded: boolean;
  sourceEvent: string;
};

export type PlayerRechargeSuccessLiveEvent = {
  requestId: string;
  playerUid: string;
  type: PlayerGameRequestType;
  status: PlayerGameRequestStatus;
  message: string;
  sourceEvent: string;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function playerRequestLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:requests`;
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

function normalizeRequestStatus(status: unknown): PlayerGameRequestStatus {
  const normalized = cleanText(status).toLowerCase();
  if (
    normalized === 'pending' ||
    normalized === 'completed' ||
    normalized === 'failed' ||
    normalized === 'poked' ||
    normalized === 'pending_review' ||
    normalized === 'dismissed'
  ) {
    return normalized;
  }
  return 'pending';
}

function normalizeRequestType(type: unknown): PlayerGameRequestType {
  return cleanText(type).toLowerCase() === 'redeem' ? 'redeem' : 'recharge';
}

function resolveEntityId(payload: SqlRequestPayload, eventName: string) {
  const entityId = cleanText(payload.entityId) || cleanText(payload.requestId);
  if (entityId) {
    return entityId;
  }
  if (eventName === 'balance_update') {
    return cleanText(payload.playerUid);
  }
  return '';
}

function mapSnapshotRowToPlayerGameRequest(row: SqlSnapshotRequest, playerUid: string): PlayerGameRequest {
  const id = cleanText(row.id);
  return {
    id,
    playerUid: cleanText(row.playerUid) || playerUid,
    gameName: cleanText(row.gameName) || 'Unknown Game',
    type: normalizeRequestType(row.type),
    status: normalizeRequestStatus(row.status),
    amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : 0,
    baseAmount:
      row.baseAmount !== undefined && row.baseAmount !== null && Number.isFinite(Number(row.baseAmount))
        ? Number(row.baseAmount)
        : null,
    pokeMessage: cleanText(row.pokeMessage) || null,
    dismissReasonCode: cleanText(row.dismissReasonCode) || null,
    dismissReasonMessage: cleanText(row.dismissReasonMessage) || null,
    createdAt: isoToTimestamp(row.createdAt),
    completedAt: isoToTimestamp(row.completedAt),
    pokedAt: isoToTimestamp(row.pokedAt),
  };
}

function mergePayloadIntoPlayerGameRequest(
  payload: SqlRequestPayload,
  existing: PlayerGameRequest | undefined,
  playerUid: string
): PlayerGameRequest {
  const id = cleanText(payload.entityId || payload.requestId || existing?.id);
  const status = cleanText(payload.status);
  const nextStatus = status ? normalizeRequestStatus(status) : existing?.status || 'pending';
  const updatedAt = isoToTimestamp(cleanText(payload.updatedAt));

  return {
    id,
    playerUid: cleanText(payload.playerUid) || existing?.playerUid || playerUid,
    gameName: cleanText(payload.gameName) || existing?.gameName || 'Unknown Game',
    type: payload.type !== undefined ? normalizeRequestType(payload.type) : existing?.type || 'recharge',
    status: nextStatus,
    amount:
      payload.amount !== undefined && payload.amount !== null
        ? Number.isFinite(Number(payload.amount))
          ? Number(payload.amount)
          : existing?.amount ?? 0
        : existing?.amount ?? 0,
    baseAmount:
      payload.baseAmount !== undefined && payload.baseAmount !== null
        ? Number.isFinite(Number(payload.baseAmount))
          ? Number(payload.baseAmount)
          : existing?.baseAmount ?? null
        : existing?.baseAmount ?? null,
    pokeMessage:
      payload.pokeMessage !== undefined
        ? cleanText(payload.pokeMessage) || null
        : existing?.pokeMessage ?? null,
    dismissReasonCode:
      payload.dismissReasonCode !== undefined
        ? cleanText(payload.dismissReasonCode) || null
        : existing?.dismissReasonCode ?? null,
    dismissReasonMessage:
      payload.dismissReasonMessage !== undefined
        ? cleanText(payload.dismissReasonMessage) || null
        : existing?.dismissReasonMessage ?? null,
    createdAt: existing?.createdAt ?? updatedAt,
    completedAt:
      nextStatus === 'completed' || nextStatus === 'dismissed'
        ? existing?.completedAt ?? updatedAt
        : existing?.completedAt ?? null,
    pokedAt:
      nextStatus === 'poked'
        ? existing?.pokedAt ?? updatedAt
        : existing?.pokedAt ?? null,
  };
}

function buildSuccessEventFromPayload(
  eventName: string,
  entityId: string,
  payload: SqlRequestPayload,
  playerUid: string
): PlayerRechargeSuccessLiveEvent | null {
  const status = normalizeRequestStatus(payload.status || 'completed');
  if (status !== 'completed') {
    return null;
  }
  const type = normalizeRequestType(payload.type);
  if (type !== 'recharge') {
    return null;
  }
  const message =
    cleanText(payload.playerMessage) ||
    cleanText(payload.pokeMessage) ||
    PLAYER_RECHARGE_SUCCESS_MESSAGE;
  return {
    requestId: entityId,
    playerUid: cleanText(payload.playerUid) || playerUid,
    type,
    status,
    message,
    sourceEvent: eventName,
  };
}

function buildDismissEventFromPayload(
  eventName: string,
  entityId: string,
  payload: SqlRequestPayload,
  playerUid: string
): PlayerRechargeDismissLiveEvent | null {
  const status = normalizeRequestStatus(payload.status || 'dismissed');
  if (status !== 'dismissed') {
    return null;
  }
  return {
    requestId: entityId,
    playerUid: cleanText(payload.playerUid) || playerUid,
    type: normalizeRequestType(payload.type),
    status,
    pokeMessage: cleanText(payload.pokeMessage) || null,
    dismissReasonCode: cleanText(payload.dismissReasonCode) || null,
    dismissReasonMessage: cleanText(payload.dismissReasonMessage) || null,
    refunded: payload.refunded === true,
    sourceEvent: eventName,
  };
}

export function attachPlayerRequestSqlReadListener(
  playerUid: string,
  onRequestsChange: (requests: PlayerGameRequest[]) => void,
  onFallback: (reason: string) => void,
  options?: {
    onRechargeDismissEvent?: (event: PlayerRechargeDismissLiveEvent) => void;
    onRechargeSuccessEvent?: (event: PlayerRechargeSuccessLiveEvent) => void;
    onBalanceUpdate?: (reason: string) => void;
  }
) {
  const cleanPlayerUid = cleanText(playerUid);
  const streamChannel = playerRequestLiveChannel(cleanPlayerUid);
  let lastEventId = 0;
  let eventSource: EventSource | null = null;
  let disposed = false;
  let fellBack = false;
  let refetchInFlight = false;
  let reconnectAttempt = 0;
  let reconnectBackoffMs = INITIAL_RECONNECT_MS;
  let lastSseActivityAt = Date.now();
  let safetyRefetchTimer: ReturnType<typeof setInterval> | null = null;
  let stallWatchTimer: ReturnType<typeof setInterval> | null = null;
  let streamConnectResolve: (() => void) | null = null;
  const requestsById = new Map<string, PlayerGameRequest>();

  const emitRequests = () => {
    if (fellBack || disposed) {
      return;
    }
    onRequestsChange(sortPlayerGameRequestsByNewest(Array.from(requestsById.values())));
  };

  const refetchSnapshotNow = async (reason: string, priority = false) => {
    if (fellBack || disposed) {
      return false;
    }
    if (refetchInFlight) {
      if (!priority) {
        return false;
      }
      for (let attempt = 0; attempt < 50 && refetchInFlight; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (refetchInFlight) {
        return false;
      }
    }

    refetchInFlight = true;
    const startedAt = Date.now();
    console.info('[PLAYER_REQUESTS_REFETCH_START]', {
      reason,
      playerUid: cleanPlayerUid,
      priority,
      lastEventId,
    });
    try {
      const headers = await getPlayerApiHeaders(false);
      const snapshotResponse = await fetch(
        `/api/live/snapshot/player/${encodeURIComponent(cleanPlayerUid)}/requests`,
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
        console.info('[PLAYER_REQUESTS_REFETCH_DONE]', {
          reason,
          ok: false,
          playerUid: cleanPlayerUid,
          durationMs: Date.now() - startedAt,
        });
        return false;
      }
      lastEventId = Math.max(lastEventId, Number(snapshot.latestOutboxId || 0));
      requestsById.clear();
      for (const row of Array.isArray(snapshot.requests) ? snapshot.requests : []) {
        const mapped = mapSnapshotRowToPlayerGameRequest(row, cleanPlayerUid);
        if (!mapped.id) {
          continue;
        }
        requestsById.set(mapped.id, mapped);
      }
      console.info('[PLAYER_REQUESTS_REFETCH_DONE]', {
        reason,
        ok: true,
        playerUid: cleanPlayerUid,
        count: requestsById.size,
        latestOutboxId: lastEventId,
        durationMs: Date.now() - startedAt,
      });
      console.info(
        '[PLAYER_REQUESTS_SQL_READ] refetch_done reason=%s count=%s durationMs=%s',
        reason,
        requestsById.size,
        Date.now() - startedAt
      );
      emitRequests();
      return true;
    } catch (error) {
      console.info('[PLAYER_REQUESTS_REFETCH_DONE]', {
        reason,
        ok: false,
        playerUid: cleanPlayerUid,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      console.info('[PLAYER_REQUESTS_SQL_READ] refetch_failed reason=%s error=%s', reason, error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      refetchInFlight = false;
    }
  };

  const handleSuccessLiveEvent = (eventName: string, payload: SqlRequestPayload, entityId: string) => {
    if (
      eventName !== 'recharge_completed' &&
      eventName !== 'request.completed' &&
      eventName !== 'game_request_complete' &&
      !(eventName === 'player_message' && normalizeRequestStatus(payload.status) === 'completed')
    ) {
      return;
    }
    const successEvent = buildSuccessEventFromPayload(eventName, entityId, payload, cleanPlayerUid);
    if (!successEvent || successEvent.type !== 'recharge' || !options?.onRechargeSuccessEvent) {
      return;
    }
    console.info('[PLAYER_RECHARGE_SUCCESS_EVENT]', successEvent);
    options.onRechargeSuccessEvent(successEvent);
  };

  const handleDismissLiveEvent = (eventName: string, payload: SqlRequestPayload, entityId: string) => {
    if (eventName !== 'recharge_dismiss' && eventName !== 'player_message') {
      return;
    }
    if (normalizeRequestStatus(payload.status) === 'completed') {
      return;
    }
    const dismissEvent = buildDismissEventFromPayload(eventName, entityId, payload, cleanPlayerUid);
    if (!dismissEvent || !options?.onRechargeDismissEvent) {
      return;
    }
    console.info('[PLAYER_RECHARGE_DISMISS_EVENT]', dismissEvent);
    if (eventName === 'player_message') {
      console.info('[PLAYER_MESSAGE_EVENT]', {
        requestId: dismissEvent.requestId,
        playerUid: dismissEvent.playerUid,
        pokeMessage: dismissEvent.pokeMessage,
      });
    }
    options.onRechargeDismissEvent(dismissEvent);
  };

  const handleStreamMessage = (eventName: string, rawData: string, outboxId: number) => {
    lastSseActivityAt = Date.now();

    if (eventName === 'ping') {
      return;
    }

    let payload: SqlRequestPayload = {};
    try {
      payload = JSON.parse(rawData) as SqlRequestPayload;
    } catch {
      return;
    }

    const payloadPlayerUid = cleanText(payload.playerUid);
    if (payloadPlayerUid && payloadPlayerUid !== cleanPlayerUid) {
      return;
    }

    const entityId = resolveEntityId(payload, eventName);
    if (!entityId && eventName !== 'balance_update') {
      return;
    }

    if (outboxId > 0) {
      lastEventId = Math.max(lastEventId, outboxId);
    }

    console.info('[PLAYER_LIVE_STREAM_EVENT]', {
      type: eventName,
      outboxId,
      entityId: entityId || null,
      playerUid: cleanPlayerUid,
      immediateRefetch: PLAYER_IMMEDIATE_REFETCH_EVENTS.has(eventName),
    });

    if (eventName === 'balance_update') {
      console.info('[PLAYER_BALANCE_EVENT]', {
        playerUid: cleanPlayerUid,
        requestId: cleanText(payload.requestId) || null,
        refunded: payload.refunded === true,
      });
      options?.onBalanceUpdate?.(`sse_event:${eventName}`);
      void refetchSnapshotNow(`sse_event:${eventName}`, true);
      return;
    }

    if (PLAYER_IMMEDIATE_REFETCH_EVENTS.has(eventName)) {
      handleSuccessLiveEvent(eventName, payload, entityId);
      handleDismissLiveEvent(eventName, payload, entityId);
      void refetchSnapshotNow(`sse_event:${eventName}`, true);
      return;
    }

    if (eventName === 'request.tombstoned' && entityId) {
      requestsById.delete(entityId);
      emitRequests();
      return;
    }

    if (eventName === 'request.upserted' && entityId) {
      const merged = mergePayloadIntoPlayerGameRequest(
        payload,
        requestsById.get(entityId),
        cleanPlayerUid
      );
      if (merged.id) {
        requestsById.set(merged.id, merged);
      }
      emitRequests();
    }
  };

  const buildStreamUrl = () => {
    const params = new URLSearchParams({
      channels: streamChannel,
      lastEventId: String(Math.max(0, lastEventId)),
    });
    const appSessionId = cleanText(getLocalAppSessionId());
    const playerSessionId = cleanText(getLocalPlayerSessionId());
    if (appSessionId) {
      params.set('appSessionId', appSessionId);
    }
    if (playerSessionId) {
      params.set('playerSessionId', playerSessionId);
    }
    return `/api/live/stream?${params.toString()}`;
  };

  const closeEventSource = (reason: string) => {
    if (!eventSource) {
      return;
    }
    eventSource.close();
    eventSource = null;
    console.info('[PLAYER_LIVE_STREAM_CLOSE]', {
      reason,
      playerUid: cleanPlayerUid,
      lastEventId,
    });
    streamConnectResolve?.();
    streamConnectResolve = null;
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
      console.info('[PLAYER_LIVE_STREAM_SUBSCRIBE]', {
        playerUid: cleanPlayerUid,
        channel: streamChannel,
        lastEventId,
        url,
      });

      const source = new EventSource(url);
      eventSource = source;

      source.onopen = () => {
        lastSseActivityAt = Date.now();
        reconnectAttempt = 0;
        reconnectBackoffMs = INITIAL_RECONNECT_MS;
        console.info('[PLAYER_LIVE_STREAM_OPEN]', {
          playerUid: cleanPlayerUid,
          channel: streamChannel,
          lastEventId,
          readyState: source.readyState,
        });
      };

      source.addEventListener('ping', (ev: Event) => {
        const message = ev as MessageEvent<string>;
        handleStreamMessage('ping', String(message.data || ''), Number(message.lastEventId) || 0);
      });

      for (const eventName of PLAYER_LIVE_SSE_EVENTS) {
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
        console.info('[PLAYER_LIVE_STREAM_ERROR]', {
          playerUid: cleanPlayerUid,
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

  const runLiveStreamLoop = async () => {
    while (!disposed && !fellBack) {
      await connectEventSource();
      if (disposed || fellBack) {
        break;
      }
      reconnectAttempt += 1;
      console.info('[PLAYER_LIVE_STREAM_RECONNECT]', {
        playerUid: cleanPlayerUid,
        attempt: reconnectAttempt,
        backoffMs: reconnectBackoffMs,
        lastEventId,
      });
      await new Promise((resolve) => setTimeout(resolve, reconnectBackoffMs));
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, MAX_RECONNECT_MS);
      await refetchSnapshotNow(`reconnect_attempt_${reconnectAttempt}`, true);
    }
  };

  const runSafetyRefetch = () => {
    if (disposed || fellBack) {
      return;
    }
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
    console.info('[PLAYER_LIVE_STREAM_ERROR]', {
      playerUid: cleanPlayerUid,
      reason: 'stall_timeout',
      idleMs,
      lastEventId,
    });
    closeEventSource('stall_timeout');
    void refetchSnapshotNow('stall_timeout', true);
  };

  const handleVisibilityRefresh = () => {
    if (disposed || fellBack || document.visibilityState !== 'visible') {
      return;
    }
    reconnectAttempt = 0;
    reconnectBackoffMs = INITIAL_RECONNECT_MS;
    closeEventSource('visibility_refresh');
    void refetchSnapshotNow('visibility', true);
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
    if (
      isPlayerSessionStale() ||
      /sse_http_401|live_auth_denied|session_inactive|session_validation_failed|player_session/i.test(
        reason
      )
    ) {
      disposed = true;
      closeEventSource('stale_session');
      stopMaintenanceTimers();
      console.info('[PLAYER_REQUESTS_SQL_READ] stale_session_stop reason=%s', reason);
      return;
    }
    fellBack = true;
    closeEventSource('fallback');
    stopMaintenanceTimers();
    console.info('[PLAYER_REQUESTS_SQL_READ] fallback_to_firebase reason=%s', reason);
    onFallback(reason);
  };

  const bootstrap = async () => {
    if (disposed || fellBack) {
      return;
    }
    const sessionUser = await checkPlayerPollRole('player_requests_sql_read');
    if (!sessionUser) {
      triggerFallback('non_player_role');
      return;
    }

    console.info('[PLAYER_REQUESTS_SQL_READ] enabled');
    try {
      const loaded = await refetchSnapshotNow('bootstrap', true);
      if (!loaded) {
        triggerFallback('snapshot_bootstrap_failed');
        return;
      }

      if (LIVE_STREAM_DISABLED) {
        console.info('[PLAYER_REQUESTS_SQL_READ] stream_skipped reason=live_stream_disabled');
        startMaintenanceTimers();
        return;
      }

      startMaintenanceTimers();
      await runLiveStreamLoop();
      if (!disposed && !fellBack) {
        triggerFallback('sse_stream_closed');
      }
    } catch (error) {
      if (!disposed) {
        if (handleStalePlayerFetchError('player_requests_sql_read', error)) {
          disposed = true;
          closeEventSource('stale_session_error');
          stopMaintenanceTimers();
          return;
        }
        const reason = error instanceof Error ? error.message : 'bootstrap_or_sse_failed';
        triggerFallback(reason);
      }
    }
  };

  const disposeRuntime = () => {
    disposed = true;
    closeEventSource('dispose');
    stopMaintenanceTimers();
    requestsById.clear();
  };

  const unregisterStopper = registerPlayerRuntimeStopper(disposeRuntime);

  void (async () => {
    const sessionUser = await checkPlayerPollRole('player_requests_sql_read');
    if (!sessionUser || disposed) {
      triggerFallback('non_player_role');
      return;
    }
    await bootstrap();
  })();

  return {
    dispose() {
      unregisterStopper();
      disposeRuntime();
    },
    hasFallenBack() {
      return fellBack;
    },
  };
}
