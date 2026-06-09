import { Timestamp } from 'firebase/firestore';

import {
  type PlayerGameRequest,
  type PlayerGameRequestStatus,
  type PlayerGameRequestType,
  sortPlayerGameRequestsByNewest,
} from '@/features/games/playerGameRequests';
import { getPlayerApiHeaders } from '@/features/auth/playerSession';
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
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  pokedAt?: string | null;
};

type SqlSnapshotResponse = {
  requests?: SqlSnapshotRequest[];
  latestOutboxId?: number;
  source?: string;
};

type SqlRequestPayload = {
  entityId?: unknown;
  playerUid?: unknown;
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  pokeMessage?: unknown;
  updatedAt?: unknown;
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
  const id = cleanText(payload.entityId || existing?.id);
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

  let payload: SqlRequestPayload = {};
  try {
    payload = JSON.parse(dataLines.join('\n')) as SqlRequestPayload;
  } catch {
    return null;
  }

  const entityId = cleanText(payload.entityId);
  return {
    id,
    event,
    entityId,
    payload,
    receivedAt: Date.now(),
  };
}

export function attachPlayerRequestSqlReadListener(
  playerUid: string,
  onRequestsChange: (requests: PlayerGameRequest[]) => void,
  onFallback: (reason: string) => void
) {
  const cleanPlayerUid = cleanText(playerUid);
  let lastEventId = 0;
  let abortController: AbortController | null = null;
  let disposed = false;
  let fellBack = false;
  const requestsById = new Map<string, PlayerGameRequest>();

  const emitRequests = () => {
    if (fellBack || disposed) {
      return;
    }
    onRequestsChange(sortPlayerGameRequestsByNewest(Array.from(requestsById.values())));
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

      const payloadPlayerUid = cleanText(parsed.payload.playerUid);
      if (payloadPlayerUid && payloadPlayerUid !== cleanPlayerUid) {
        continue;
      }

      lastEventId = Math.max(lastEventId, parsed.id);

      if (parsed.event === 'request.tombstoned') {
        requestsById.delete(parsed.entityId);
        console.info(
          '[PLAYER_REQUESTS_SQL_READ] sse_event type=%s requestId=%s',
          parsed.event,
          parsed.entityId
        );
        emitRequests();
        continue;
      }

      if (parsed.event === 'request.upserted') {
        const merged = mergePayloadIntoPlayerGameRequest(
          parsed.payload,
          requestsById.get(parsed.entityId),
          cleanPlayerUid
        );
        if (merged.id) {
          requestsById.set(merged.id, merged);
        }
        console.info(
          '[PLAYER_REQUESTS_SQL_READ] sse_event type=%s requestId=%s',
          parsed.event,
          parsed.entityId
        );
        emitRequests();
      }
    }
  };

  const connectStream = async (headers: Record<string, string>) => {
    const channel = encodeURIComponent(playerRequestLiveChannel(cleanPlayerUid));
    const url = `/api/live/stream?channels=${channel}&lastEventId=${lastEventId}`;
    const response = await fetch(url, {
      headers,
      signal: abortController?.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) {
      const status = response.status;
      console.info('[PLAYER_REQUESTS_SQL_READ] stream_http_error', {
        status,
        logout_suppressed: status === 401,
      });
      throw new Error(`sse_http_${status}`);
    }

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
    console.info('[PLAYER_REQUESTS_SQL_READ] fallback_to_firebase reason=%s', reason);
    onFallback(reason);
  };

  const bootstrap = async () => {
    console.info('[PLAYER_REQUESTS_SQL_READ] enabled');
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
        triggerFallback(`snapshot_http_${snapshotResponse.status}_${source || 'unknown'}`);
        return;
      }

      lastEventId = Number(snapshot.latestOutboxId || 0);
      requestsById.clear();
      for (const row of Array.isArray(snapshot.requests) ? snapshot.requests : []) {
        const mapped = mapSnapshotRowToPlayerGameRequest(row, cleanPlayerUid);
        if (!mapped.id) {
          continue;
        }
        requestsById.set(mapped.id, mapped);
      }

      console.info(
        '[PLAYER_REQUESTS_SQL_READ] snapshot_loaded count=%s latestOutboxId=%s source=%s',
        requestsById.size,
        lastEventId,
        source || 'unknown'
      );
      emitRequests();

      if (LIVE_STREAM_DISABLED) {
        console.info('[PLAYER_REQUESTS_SQL_READ] stream_skipped reason=live_stream_disabled');
        return;
      }

      abortController = new AbortController();
      await connectStream(headers);
      if (!disposed && !fellBack) {
        triggerFallback('sse_stream_closed');
      }
    } catch (error) {
      if (!disposed) {
        const reason = error instanceof Error ? error.message : 'bootstrap_or_sse_failed';
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
      requestsById.clear();
    },
    hasFallenBack() {
      return fellBack;
    },
  };
}
