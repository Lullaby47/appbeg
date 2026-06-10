import type { PlayerGameRequest } from '@/features/games/playerGameRequests';
import { getPlayerApiHeaders } from '@/features/auth/playerSession';
import { checkPlayerPollRole } from '@/lib/client/playerPollGuard';
import { LIVE_STREAM_DISABLED } from '@/features/live/liveStreamFlags';
type ShadowRequestPayload = {
  entityId?: unknown;
  status?: unknown;
};

type ShadowSnapshotResponse = {
  requests?: Array<{ id?: string; status?: string }>;
  latestOutboxId?: number;
};

const LIVE_SHADOW_COMPARE_ENABLED =
  String(process.env.NEXT_PUBLIC_LIVE_SHADOW_COMPARE || '').trim() === '1';

function cleanText(value: unknown) {
  return String(value || '').trim();
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

  let payload: ShadowRequestPayload = {};
  try {
    payload = JSON.parse(dataLines.join('\n')) as ShadowRequestPayload;
  } catch {
    return null;
  }

  return {
    id,
    event,
    entityId: cleanText(payload.entityId),
    status: cleanText(payload.status),
    receivedAt: Date.now(),
  };
}

export function attachPlayerRequestLiveShadowCompare(playerUid: string) {
  if (!LIVE_SHADOW_COMPARE_ENABLED || !playerUid) {
    return {
      reportFirebaseSnapshot: (_requests: PlayerGameRequest[]) => undefined,
      dispose: () => undefined,
    };
  }

  const sseStatusByEntityId = new Map<string, { status: string; receivedAt: number }>();
  let lastEventId = 0;
  let abortController: AbortController | null = null;
  let disposed = false;

  const compareAndLog = (requests: PlayerGameRequest[], source: 'firebase') => {
    for (const request of requests) {
      const entityId = cleanText(request.id);
      if (!entityId) continue;

      const sseEntry = sseStatusByEntityId.get(entityId);
      if (!sseEntry) continue;

      const firebaseStatus = cleanText(request.status);
      const match = firebaseStatus === sseEntry.status;
      console.info('[LIVE_SHADOW_COMPARE] player_request', {
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

      lastEventId = Math.max(lastEventId, parsed.id);
      sseStatusByEntityId.set(parsed.entityId, {
        status: parsed.status,
        receivedAt: parsed.receivedAt,
      });

      console.info('[LIVE_SHADOW_COMPARE] sse_event', {
        entityId: parsed.entityId,
        event: parsed.event,
        sseStatus: parsed.status,
        outboxId: parsed.id,
      });
    }
  };

  const connectStream = async (headers: Record<string, string>) => {
    const channel = encodeURIComponent(`player:${playerUid}:requests`);
    const url = `/api/live/stream?channels=${channel}&lastEventId=${lastEventId}`;
    const response = await fetch(url, {
      headers,
      signal: abortController?.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) {
      console.info('[LIVE_SHADOW_COMPARE] stream_failed', {
        playerUid,
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
    const sessionUser = await checkPlayerPollRole('player_requests_shadow_compare');
    if (!sessionUser || disposed) {
      return;
    }

    try {
      const headers = await getPlayerApiHeaders(false);
      const snapshotResponse = await fetch(
        `/api/live/snapshot/player/${encodeURIComponent(playerUid)}/requests`,
        {
          headers,
          cache: 'no-store',
        }
      );
      const snapshot = (await snapshotResponse.json()) as ShadowSnapshotResponse;
      lastEventId = Number(snapshot.latestOutboxId || 0);

      console.info('[LIVE_SHADOW_COMPARE] snapshot_loaded', {
        playerUid,
        requestCount: Array.isArray(snapshot.requests) ? snapshot.requests.length : 0,
        latestOutboxId: lastEventId,
        status: snapshotResponse.status,
      });

      if (LIVE_STREAM_DISABLED) {
        console.info('[LIVE_SHADOW_COMPARE] stream_skipped reason=live_stream_disabled');
        return;
      }

      abortController = new AbortController();
      await connectStream(headers);
    } catch (error) {
      if (!disposed) {
        console.info('[LIVE_SHADOW_COMPARE] bootstrap_failed', { playerUid, error });
      }
    }
  };
  void (async () => {
    await bootstrap();
  })();

  return {
    reportFirebaseSnapshot(requests: PlayerGameRequest[]) {
      compareAndLog(requests, 'firebase');
    },
    dispose() {
      disposed = true;
      abortController?.abort();
      abortController = null;
    },
  };
}
