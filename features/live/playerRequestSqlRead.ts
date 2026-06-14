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

const PLAYER_OUTCOME_SSE_EVENTS = [
  'request.message',
  'recharge_sent',
  'redeem_sent',
  'recharge_completed',
  'redeem_completed',
  'recharge_dismissed',
  'redeem_dismissed',
] as const;

const PLAYER_IMMEDIATE_REFETCH_EVENTS = new Set([
  ...PLAYER_OUTCOME_SSE_EVENTS,
  'recharge_dismiss',
  'redeem_dismiss',
  'recharge_create',
  'redeem_create',
  'request.completed',
  'request.dismissed',
  'game_request_complete',
  'player_message',
  'balance_update',
  'freeplay.given',
  'freeplay_pending',
  'request.upserted',
  'task.dismissed',
]);

const PLAYER_LIVE_SSE_EVENTS = [
  ...PLAYER_OUTCOME_SSE_EVENTS,
  'recharge_dismiss',
  'redeem_dismiss',
  'recharge_completed',
  'redeem_completed',
  'request.completed',
  'request.dismissed',
  'game_request_complete',
  'player_message',
  'balance_update',
  'freeplay.given',
  'freeplay_pending',
  'player_game_login.updated',
  'request.upserted',
  'request.tombstoned',
  'recharge_create',
  'redeem_create',
  'task.dismissed',
] as const;

export const PLAYER_RECHARGE_SENT_MESSAGE = 'Recharge successfully sent.';
export const PLAYER_REDEEM_SENT_MESSAGE = 'Redeem request successfully sent.';
export const PLAYER_RECHARGE_SUCCESS_MESSAGE = 'Your game is recharged. Enjoy!';
export const PLAYER_REDEEM_SUCCESS_MESSAGE = 'You have successfully redeemed from your game.';
export const FAKE_REDEEM_REASON_CODE = 'fake_redeem';
export const PLAYER_FAKE_REDEEM_DEFAULT_MESSAGE =
  'Redeem could not be completed because the game balance is lower than the requested redeem amount.';
export const PLAYER_IN_GAME_REASON_CODE = 'PLAYER_IN_GAME';
export const GAME_RECHARGE_REDEEM_FAILED_IN_GAME_REASON = 'GAME_RECHARGE_REDEEM_FAILED_IN_GAME';
export const PLAYER_IN_GAME_RECHARGE_SPLASH_MESSAGE =
  'Recharge failed because player is currently in game. Coins have been refunded.';
export const PLAYER_IN_GAME_REDEEM_SPLASH_MESSAGE =
  'Redeem failed because player is currently in game. Please try again later.';

function normalizePlayerInGameFailureText(value: unknown) {
  return cleanText(value).toLowerCase().replaceAll('in-game', 'in game');
}

export function requestMatchesPlayerInGameDismiss(input: {
  dismissReasonCode?: string | null;
  pokeMessage?: string | null;
  dismissReasonMessage?: string | null;
}) {
  const code = cleanText(input.dismissReasonCode).toUpperCase();
  if (
    code === PLAYER_IN_GAME_REASON_CODE ||
    code === GAME_RECHARGE_REDEEM_FAILED_IN_GAME_REASON
  ) {
    return true;
  }
  const text = [input.pokeMessage, input.dismissReasonMessage]
    .map((value) => normalizePlayerInGameFailureText(value))
    .filter(Boolean)
    .join(' ');
  if (!text) {
    return false;
  }
  return (
    text.includes('recharge or redeem failed in game') ||
    text.includes('player is currently in game') ||
    text.includes('player is in game') ||
    text.includes('currently in game') ||
    (text.includes('failed in game') &&
      (text.includes('recharge') || text.includes('redeem') || text.includes('player')))
  );
}

export function playerInGameDismissSplashMessage(input: {
  requestType?: string | null;
  pokeMessage?: string | null;
  dismissReasonMessage?: string | null;
  refunded?: boolean;
}) {
  const isRedeem = cleanText(input.requestType).toLowerCase() === 'redeem';
  const base = isRedeem
    ? 'Redeem failed because player is currently in game.'
    : 'Recharge failed because player is currently in game.';
  if (input.refunded === false) {
    return (
      cleanText(input.pokeMessage) ||
      cleanText(input.dismissReasonMessage) ||
      base
    );
  }
  const refundLine = isRedeem ? 'Please try again later.' : 'Coins have been refunded.';
  return `${base} ${refundLine}`;
}

export function requestMatchesFakeRedeemDismiss(input: {
  dismissReasonCode?: string | null;
  pokeMessage?: string | null;
  dismissReasonMessage?: string | null;
}) {
  const code = cleanText(input.dismissReasonCode).toLowerCase();
  if (code === FAKE_REDEEM_REASON_CODE || code.includes('fake_redeem')) {
    return true;
  }
  return [input.pokeMessage, input.dismissReasonMessage].some((value) =>
    cleanText(value).toLowerCase().startsWith('redeem could not be completed')
  );
}

export function buildPlayerRedeemDismissMessage(rawMessage: string | null | undefined) {
  const message = cleanText(rawMessage);
  if (!message) {
    return PLAYER_FAKE_REDEEM_DEFAULT_MESSAGE;
  }
  const lower = message.toLowerCase();
  if (lower.startsWith('redeem could not be completed')) {
    return message;
  }
  if (/^[a-z][a-z0-9_]*$/i.test(message) && message.includes('_')) {
    return PLAYER_FAKE_REDEEM_DEFAULT_MESSAGE;
  }
  return `Redeem could not be completed: ${message}`;
}

export function fakeRedeemDismissSplashMessage(input: {
  pokeMessage?: string | null;
  dismissReasonMessage?: string | null;
}) {
  return (
    cleanText(input.pokeMessage) ||
    cleanText(input.dismissReasonMessage) ||
    PLAYER_FAKE_REDEEM_DEFAULT_MESSAGE
  );
}

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
  requestType?: unknown;
  status?: unknown;
  outcomeType?: unknown;
  message?: unknown;
  toastVariant?: unknown;
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  pokeMessage?: unknown;
  playerMessage?: unknown;
  dismissReasonCode?: unknown;
  dismissReasonMessage?: unknown;
  refunded?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown;
  freeplayGiftId?: unknown;
  giftId?: unknown;
};

export type PlayerRequestToastVariant = 'success' | 'info' | 'error' | 'warning';

export type PlayerRequestOutcomeType =
  | 'recharge_sent'
  | 'redeem_sent'
  | 'recharge_completed'
  | 'redeem_completed'
  | 'recharge_dismissed'
  | 'redeem_dismissed';

export type PlayerRequestOutcomeLiveEvent = {
  requestId: string;
  playerUid: string;
  requestType: PlayerGameRequestType;
  outcomeType: PlayerRequestOutcomeType;
  status: PlayerGameRequestStatus;
  message: string;
  toastVariant: PlayerRequestToastVariant;
  pokeMessage: string | null;
  dismissReasonCode: string | null;
  dismissReasonMessage: string | null;
  refunded: boolean;
  sourceEvent: string;
  outboxId?: number;
  eventAtMs?: number;
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
  outboxId?: number;
  eventAtMs?: number;
};

export type PlayerRechargeSuccessLiveEvent = {
  requestId: string;
  playerUid: string;
  type: PlayerGameRequestType;
  status: PlayerGameRequestStatus;
  message: string;
  sourceEvent: string;
  outboxId?: number;
  eventAtMs?: number;
};

export type PlayerRedeemDismissLiveEvent = PlayerRechargeDismissLiveEvent;

export type PlayerFreeplayGivenLiveEvent = {
  playerUid: string;
  freeplayGiftId: string;
  amount: number | null;
  message: string;
  createdAt: string | null;
  sourceEvent: string;
  outboxId?: number;
  eventAtMs?: number;
};

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function parsePayloadEventAtMs(payload: SqlRequestPayload): number | undefined {
  for (const field of [payload.updatedAt, payload.completedAt, payload.createdAt]) {
    const ms = Date.parse(String(field || ''));
    if (Number.isFinite(ms)) {
      return ms;
    }
  }
  return undefined;
}

function attachLiveEventMeta<T extends { sourceEvent: string }>(
  event: T,
  outboxId: number,
  payload: SqlRequestPayload
): T & { outboxId?: number; eventAtMs?: number } {
  return {
    ...event,
    outboxId: outboxId > 0 ? outboxId : undefined,
    eventAtMs: parsePayloadEventAtMs(payload),
  };
}

function playerRequestLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:requests`;
}

function playerFreeplayLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:freeplay`;
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
  if (eventName === 'freeplay.given' || eventName === 'freeplay_pending') {
    return cleanText(payload.freeplayGiftId) || cleanText(payload.giftId);
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

function normalizeOutcomeType(
  eventName: string,
  payload: SqlRequestPayload
): PlayerRequestOutcomeType | null {
  const explicit = cleanText(payload.outcomeType);
  if (
    explicit === 'recharge_sent' ||
    explicit === 'redeem_sent' ||
    explicit === 'recharge_completed' ||
    explicit === 'redeem_completed' ||
    explicit === 'recharge_dismissed' ||
    explicit === 'redeem_dismissed'
  ) {
    return explicit;
  }
  if (eventName === 'recharge_sent') return 'recharge_sent';
  if (eventName === 'redeem_sent') return 'redeem_sent';
  if (eventName === 'recharge_completed') return 'recharge_completed';
  if (eventName === 'redeem_completed') return 'redeem_completed';
  if (eventName === 'recharge_dismissed' || eventName === 'recharge_dismiss') {
    return 'recharge_dismissed';
  }
  if (eventName === 'redeem_dismissed' || eventName === 'redeem_dismiss') {
    return 'redeem_dismissed';
  }
  if (eventName === 'recharge_create') return 'recharge_sent';
  if (eventName === 'redeem_create') return 'redeem_sent';
  if (eventName === 'request.completed') {
    return normalizeRequestType(payload.requestType || payload.type) === 'redeem'
      ? 'redeem_completed'
      : 'recharge_completed';
  }
  if (eventName === 'request.dismissed') {
    return 'redeem_dismissed';
  }
  if (eventName === 'player_message') {
    const status = normalizeRequestStatus(payload.status);
    const requestType = normalizeRequestType(payload.requestType || payload.type);
    if (status === 'completed') {
      return requestType === 'redeem' ? 'redeem_completed' : 'recharge_completed';
    }
    if (status === 'dismissed') {
      return requestType === 'redeem' ? 'redeem_dismissed' : 'recharge_dismissed';
    }
  }
  return null;
}

function normalizeToastVariant(value: unknown): PlayerRequestToastVariant {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === 'success' || normalized === 'info' || normalized === 'error' || normalized === 'warning') {
    return normalized;
  }
  return 'info';
}

function defaultToastVariantForOutcome(outcomeType: PlayerRequestOutcomeType): PlayerRequestToastVariant {
  if (outcomeType.endsWith('_completed')) {
    return 'success';
  }
  if (outcomeType.endsWith('_dismissed')) {
    return 'error';
  }
  return 'info';
}

function defaultMessageForOutcome(outcomeType: PlayerRequestOutcomeType): string {
  switch (outcomeType) {
    case 'recharge_sent':
      return PLAYER_RECHARGE_SENT_MESSAGE;
    case 'redeem_sent':
      return PLAYER_REDEEM_SENT_MESSAGE;
    case 'recharge_completed':
      return PLAYER_RECHARGE_SUCCESS_MESSAGE;
    case 'redeem_completed':
      return PLAYER_REDEEM_SUCCESS_MESSAGE;
    case 'redeem_dismissed':
      return PLAYER_FAKE_REDEEM_DEFAULT_MESSAGE;
    default:
      return '';
  }
}

function buildOutcomeEventFromPayload(
  eventName: string,
  entityId: string,
  payload: SqlRequestPayload,
  playerUid: string
): PlayerRequestOutcomeLiveEvent | null {
  const outcomeType = normalizeOutcomeType(eventName, payload);
  if (!outcomeType) {
    return null;
  }
  const requestType =
    outcomeType.startsWith('redeem') || normalizeRequestType(payload.requestType || payload.type) === 'redeem'
      ? 'redeem'
      : 'recharge';
  const status =
    outcomeType.endsWith('_sent')
      ? 'pending'
      : outcomeType.endsWith('_completed')
        ? 'completed'
        : outcomeType.endsWith('_dismissed')
          ? 'dismissed'
          : normalizeRequestStatus(payload.status);
  const message =
    cleanText(payload.message) ||
    cleanText(payload.playerMessage) ||
    cleanText(payload.pokeMessage) ||
    defaultMessageForOutcome(outcomeType);
  if (!message) {
    return null;
  }
  return {
    requestId: entityId,
    playerUid: cleanText(payload.playerUid) || playerUid,
    requestType,
    outcomeType,
    status,
    message,
    toastVariant: cleanText(payload.toastVariant)
      ? normalizeToastVariant(payload.toastVariant)
      : defaultToastVariantForOutcome(outcomeType),
    pokeMessage: cleanText(payload.pokeMessage) || cleanText(payload.message) || null,
    dismissReasonCode: cleanText(payload.dismissReasonCode) || null,
    dismissReasonMessage: cleanText(payload.dismissReasonMessage) || null,
    refunded: payload.refunded === true,
    sourceEvent: eventName,
  };
}

function outcomeEventNeedsBalanceRefetch(eventName: string, payload: SqlRequestPayload) {
  const outcomeType = normalizeOutcomeType(eventName, payload);
  return (
    outcomeType === 'recharge_sent' ||
    outcomeType === 'recharge_completed' ||
    outcomeType === 'recharge_dismissed' ||
    outcomeType === 'redeem_completed' ||
    payload.refunded === true ||
    eventName === 'balance_update'
  );
}

function buildFreeplayGivenEventFromPayload(
  eventName: string,
  payload: SqlRequestPayload,
  playerUid: string
): PlayerFreeplayGivenLiveEvent | null {
  if (eventName !== 'freeplay.given' && eventName !== 'freeplay_pending') {
    return null;
  }
  const freeplayGiftId = cleanText(payload.freeplayGiftId) || cleanText(payload.giftId);
  if (!freeplayGiftId) {
    return null;
  }
  return {
    playerUid: cleanText(payload.playerUid) || playerUid,
    freeplayGiftId,
    amount: Number.isFinite(Number(payload.amount)) ? Number(payload.amount) : null,
    message: cleanText(payload.message) || 'You received freeplay.',
    createdAt: cleanText(payload.createdAt) || cleanText(payload.updatedAt) || null,
    sourceEvent: eventName,
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
  const type = normalizeRequestType(payload.requestType || payload.type);
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
    onRequestOutcomeEvent?: (event: PlayerRequestOutcomeLiveEvent) => void;
    onRechargeDismissEvent?: (event: PlayerRechargeDismissLiveEvent) => void;
    onRechargeSuccessEvent?: (event: PlayerRechargeSuccessLiveEvent) => void;
    onRedeemDismissEvent?: (event: PlayerRedeemDismissLiveEvent) => void;
    onFreeplayGivenEvent?: (event: PlayerFreeplayGivenLiveEvent) => void;
    onBalanceUpdate?: (reason: string) => void;
    onPlayerGameLoginUpdated?: (
      reason: string,
      meta?: {
        updateReason?: string | null;
        gameName?: string | null;
        pokeMessage?: string | null;
        outboxId?: number;
        eventAtMs?: number;
      }
    ) => void;
    onSnapshotBootstrap?: (meta: { latestOutboxId: number }) => void;
  }
) {
  const cleanPlayerUid = cleanText(playerUid);
  const streamChannels = [
    playerRequestLiveChannel(cleanPlayerUid),
    playerFreeplayLiveChannel(cleanPlayerUid),
  ];
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
      if (reason === 'bootstrap') {
        options?.onSnapshotBootstrap?.({ latestOutboxId: lastEventId });
      }
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

  const handleOutcomeLiveEvent = (
    eventName: string,
    payload: SqlRequestPayload,
    entityId: string,
    outboxId: number
  ) => {
    const outcomeEvent = buildOutcomeEventFromPayload(eventName, entityId, payload, cleanPlayerUid);
    if (!outcomeEvent || !options?.onRequestOutcomeEvent) {
      return;
    }
    const enriched = attachLiveEventMeta(outcomeEvent, outboxId, payload);
    console.info('[PLAYER_REQUEST_OUTCOME_EVENT]', enriched);
    options.onRequestOutcomeEvent(enriched);
  };

  const handleSuccessLiveEvent = (
    eventName: string,
    payload: SqlRequestPayload,
    entityId: string,
    outboxId: number
  ) => {
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
    if (options?.onRequestOutcomeEvent) {
      return;
    }
    const enriched = attachLiveEventMeta(successEvent, outboxId, payload);
    console.info('[PLAYER_RECHARGE_SUCCESS_EVENT]', enriched);
    options.onRechargeSuccessEvent(enriched);
  };

  const handleDismissLiveEvent = (
    eventName: string,
    payload: SqlRequestPayload,
    entityId: string,
    outboxId: number
  ) => {
    if (
      eventName !== 'recharge_dismiss' &&
      eventName !== 'redeem_dismiss' &&
      eventName !== 'request.dismissed' &&
      eventName !== 'player_message'
    ) {
      return;
    }
    if (normalizeRequestStatus(payload.status) === 'completed') {
      return;
    }
    const dismissEvent = buildDismissEventFromPayload(eventName, entityId, payload, cleanPlayerUid);
    if (!dismissEvent) {
      return;
    }
    if (dismissEvent.type === 'redeem') {
      if (!options?.onRedeemDismissEvent) {
        return;
      }
      if (options?.onRequestOutcomeEvent) {
        return;
      }
      console.info('[PLAYER_REDEEM_DISMISS_EVENT]', dismissEvent);
      if (eventName === 'player_message') {
        console.info('[PLAYER_MESSAGE_EVENT]', {
          requestId: dismissEvent.requestId,
          playerUid: dismissEvent.playerUid,
          pokeMessage: dismissEvent.pokeMessage,
        });
      }
      options.onRedeemDismissEvent(attachLiveEventMeta(dismissEvent, outboxId, payload));
      return;
    }
    if (!options?.onRechargeDismissEvent) {
      return;
    }
    if (options?.onRequestOutcomeEvent) {
      return;
    }
    const enriched = attachLiveEventMeta(dismissEvent, outboxId, payload);
    console.info('[PLAYER_RECHARGE_DISMISS_EVENT]', enriched);
    if (eventName === 'player_message') {
      console.info('[PLAYER_MESSAGE_EVENT]', {
        requestId: dismissEvent.requestId,
        playerUid: dismissEvent.playerUid,
        pokeMessage: dismissEvent.pokeMessage,
      });
    }
    options.onRechargeDismissEvent(enriched);
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
      eventType: eventName,
      outboxId,
      entityId: entityId || null,
      playerUid: cleanPlayerUid,
      immediateRefetch: PLAYER_IMMEDIATE_REFETCH_EVENTS.has(eventName),
    });

    if (eventName === 'freeplay.given' || eventName === 'freeplay_pending') {
      const freeplayEvent = buildFreeplayGivenEventFromPayload(eventName, payload, cleanPlayerUid);
      if (freeplayEvent && options?.onFreeplayGivenEvent) {
        const enriched = attachLiveEventMeta(freeplayEvent, outboxId, payload);
        console.info('[PLAYER_FREEPLAY_EVENT]', enriched);
        options.onFreeplayGivenEvent(enriched);
      }
      return;
    }

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

    if (eventName === 'player_game_login.updated') {
      const loginPayload = payload as SqlRequestPayload & {
        loginId?: unknown;
        taskId?: unknown;
        updateReason?: unknown;
        pokeMessage?: unknown;
      };
      const updateReason = cleanText(loginPayload.updateReason) || null;
      const gameName = cleanText(loginPayload.gameName) || null;
      const pokeMessage = cleanText(loginPayload.pokeMessage) || null;
      console.info('[PLAYER_GAME_LOGIN_UPDATED_EVENT]', {
        playerUid: cleanPlayerUid,
        loginId: cleanText(loginPayload.loginId) || cleanText(loginPayload.entityId) || null,
        gameName,
        taskId: cleanText(loginPayload.taskId) || null,
        updateReason,
      });
      console.info('[PLAYER_PLAYTAB_GAME_LOGIN_UPDATED_EVENT]', {
        playerUid: cleanPlayerUid,
        gameName,
        updateReason,
      });
      options?.onPlayerGameLoginUpdated?.(`sse_event:${eventName}`, {
        updateReason,
        gameName,
        pokeMessage,
        outboxId: outboxId > 0 ? outboxId : undefined,
        eventAtMs: parsePayloadEventAtMs(loginPayload),
      });
      return;
    }

    if (PLAYER_IMMEDIATE_REFETCH_EVENTS.has(eventName)) {
      handleOutcomeLiveEvent(eventName, payload, entityId, outboxId);
      handleSuccessLiveEvent(eventName, payload, entityId, outboxId);
      handleDismissLiveEvent(eventName, payload, entityId, outboxId);
      if (
        outcomeEventNeedsBalanceRefetch(eventName, payload) &&
        options?.onBalanceUpdate
      ) {
        options.onBalanceUpdate(`sse_event:${eventName}`);
      }
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
      channels: streamChannels.join(','),
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
        console.info('[PLAYER_LIVE_STREAM_OPEN]', {
          playerUid: cleanPlayerUid,
          channels: streamChannels,
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
