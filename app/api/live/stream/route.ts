import {
  apiError,
  requireCarerOwnedLiveAuth,
  requirePlayerOwnedLiveAuth,
  verifyApiTokenIdentity,
} from '@/lib/firebase/apiAuth';
import { authSqlReadEnvLogFields } from '@/lib/server/authSqlRead';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { getLiveOutboxRowsAfter, type LiveOutboxRow } from '@/lib/sql/liveOutbox';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_CHANNELS = 3;
const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PLAYER_CHANNEL_PATTERN = /^player:([A-Za-z0-9_-]+):requests$/;
const CARER_CHANNEL_PATTERN = /^carer:([A-Za-z0-9_-]+):tasks$/;
const COADMIN_CHANNEL_PATTERN = /^coadmin:([A-Za-z0-9_-]+):tasks$/;
const CARER_JOBS_CHANNEL_PATTERN = /^carer:([A-Za-z0-9_-]+):jobs$/;
const COADMIN_JOBS_CHANNEL_PATTERN = /^coadmin:([A-Za-z0-9_-]+):jobs$/;

type CarerStreamChannelSpec = {
  channels: string[];
  carerUid: string | null;
  coadminUid: string | null;
  channelType: 'carer_tasks' | 'coadmin_tasks_for_carer' | 'carer_and_coadmin_tasks';
};

type CarerJobStreamChannelSpec = {
  channels: string[];
  carerUid: string | null;
  coadminUid: string | null;
  channelType: 'carer_jobs' | 'coadmin_jobs_for_carer' | 'carer_and_coadmin_jobs';
};

function parseChannels(raw: string | null) {
  return String(raw || '')
    .split(',')
    .map(cleanText)
    .filter(Boolean)
    .slice(0, MAX_CHANNELS);
}

function parseLastEventId(raw: string | null) {
  const parsed = Number.parseInt(String(raw || '0'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatSseEvent(row: LiveOutboxRow) {
  return `id: ${row.outbox_id}\nevent: ${row.event_type}\ndata: ${JSON.stringify(row.payload)}\n\n`;
}

function resolvePlayerOwnedChannels(channels: string[]): string[] | null {
  const playerUids = new Set<string>();

  for (const channel of channels) {
    const playerMatch = channel.match(PLAYER_CHANNEL_PATTERN);
    if (!playerMatch) {
      return null;
    }
    playerUids.add(playerMatch[1]);
  }

  if (playerUids.size !== 1) {
    return null;
  }

  return channels;
}

function resolveCarerTaskStreamChannels(channels: string[]): CarerStreamChannelSpec | null {
  let carerUid: string | null = null;
  let coadminUid: string | null = null;

  for (const channel of channels) {
    const carerMatch = channel.match(CARER_CHANNEL_PATTERN);
    if (carerMatch) {
      const uid = carerMatch[1];
      if (carerUid && carerUid !== uid) {
        return null;
      }
      carerUid = uid;
      continue;
    }

    const coadminMatch = channel.match(COADMIN_CHANNEL_PATTERN);
    if (coadminMatch) {
      const uid = coadminMatch[1];
      if (coadminUid && coadminUid !== uid) {
        return null;
      }
      coadminUid = uid;
      continue;
    }

    return null;
  }

  if (!carerUid && !coadminUid) {
    return null;
  }

  if (carerUid && coadminUid) {
    return {
      channels,
      carerUid,
      coadminUid,
      channelType: 'carer_and_coadmin_tasks',
    };
  }

  if (carerUid) {
    return {
      channels,
      carerUid,
      coadminUid: null,
      channelType: 'carer_tasks',
    };
  }

  return {
    channels,
    carerUid: null,
    coadminUid,
    channelType: 'coadmin_tasks_for_carer',
  };
}

function resolveCarerJobStreamChannels(channels: string[]): CarerJobStreamChannelSpec | null {
  let carerUid: string | null = null;
  let coadminUid: string | null = null;

  for (const channel of channels) {
    const carerMatch = channel.match(CARER_JOBS_CHANNEL_PATTERN);
    if (carerMatch) {
      const uid = carerMatch[1];
      if (carerUid && carerUid !== uid) {
        return null;
      }
      carerUid = uid;
      continue;
    }

    const coadminMatch = channel.match(COADMIN_JOBS_CHANNEL_PATTERN);
    if (coadminMatch) {
      const uid = coadminMatch[1];
      if (coadminUid && coadminUid !== uid) {
        return null;
      }
      coadminUid = uid;
      continue;
    }

    return null;
  }

  if (!carerUid && !coadminUid) {
    return null;
  }

  if (carerUid && coadminUid) {
    return {
      channels,
      carerUid,
      coadminUid,
      channelType: 'carer_and_coadmin_jobs',
    };
  }

  if (carerUid) {
    return {
      channels,
      carerUid,
      coadminUid: null,
      channelType: 'carer_jobs',
    };
  }

  return {
    channels,
    carerUid: null,
    coadminUid,
    channelType: 'coadmin_jobs_for_carer',
  };
}

async function authorizeCarerTaskStream(
  request: Request,
  spec: CarerStreamChannelSpec
) {
  const expectedCarerUid = spec.carerUid;
  if (expectedCarerUid) {
    const auth = await requireCarerOwnedLiveAuth(request, expectedCarerUid);
    if (!auth.ok) {
      return { ok: false as const, response: auth.response };
    }
    if (spec.coadminUid && auth.coadminUid !== spec.coadminUid) {
      return { ok: false as const, response: apiError('Forbidden.', 403) };
    }
    return { ok: true as const, auth };
  }

  const identity = await verifyApiTokenIdentity(request);
  if ('response' in identity) {
    return { ok: false as const, response: identity.response };
  }

  const auth = await requireCarerOwnedLiveAuth(request, identity.uid);
  if (!auth.ok) {
    return { ok: false as const, response: auth.response };
  }
  if (!spec.coadminUid || auth.coadminUid !== spec.coadminUid) {
    return { ok: false as const, response: apiError('Forbidden.', 403) };
  }

  return { ok: true as const, auth };
}

async function authorizeCarerJobStream(
  request: Request,
  spec: CarerJobStreamChannelSpec
) {
  const expectedCarerUid = spec.carerUid;
  if (expectedCarerUid) {
    const auth = await requireCarerOwnedLiveAuth(request, expectedCarerUid);
    if (!auth.ok) {
      return { ok: false as const, response: auth.response };
    }
    if (spec.coadminUid && auth.coadminUid !== spec.coadminUid) {
      return { ok: false as const, response: apiError('Forbidden.', 403) };
    }
    return { ok: true as const, auth };
  }

  const identity = await verifyApiTokenIdentity(request);
  if ('response' in identity) {
    return { ok: false as const, response: identity.response };
  }

  const auth = await requireCarerOwnedLiveAuth(request, identity.uid);
  if (!auth.ok) {
    return { ok: false as const, response: auth.response };
  }
  if (!spec.coadminUid || auth.coadminUid !== spec.coadminUid) {
    return { ok: false as const, response: apiError('Forbidden.', 403) };
  }

  return { ok: true as const, auth };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const channels = parseChannels(url.searchParams.get('channels'));
  if (!channels.length) {
    return apiError('channels query parameter is required.', 400);
  }

  const playerChannels = resolvePlayerOwnedChannels(channels);
  if (playerChannels) {
    const playerUid = playerChannels[0].match(PLAYER_CHANNEL_PATTERN)?.[1] || '';
    const auth = await requirePlayerOwnedLiveAuth(request, playerUid);
    if (!auth.ok) {
      console.info('[LIVE_STREAM_AUTH]', {
        ok: false,
        channelType: 'player_requests',
        playerUid,
        ...authSqlReadEnvLogFields(),
        ...auth.timing,
      });
      return auth.response;
    }

    console.info('[LIVE_STREAM_AUTH]', {
      ok: true,
      channelType: 'player_requests',
      playerUid,
      ...authSqlReadEnvLogFields(),
      ...auth.timing,
    });

    return createLiveStreamResponse(
      request,
      playerChannels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  const carerTaskStream = resolveCarerTaskStreamChannels(channels);
  const carerJobStream = resolveCarerJobStreamChannels(channels);

  if (carerTaskStream && carerJobStream) {
    return apiError('Cannot mix task and job live channels.', 400);
  }

  if (carerTaskStream) {
    const auth = await authorizeCarerTaskStream(request, carerTaskStream);
    if (!auth.ok) {
      return auth.response;
    }

    console.info('[LIVE_STREAM_AUTH]', {
      channelType: carerTaskStream.channelType,
      carerUid: auth.auth.uid,
      coadminUid: auth.auth.coadminUid,
      ...auth.auth.timing,
    });

    return createLiveStreamResponse(
      request,
      carerTaskStream.channels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  if (carerJobStream) {
    const auth = await authorizeCarerJobStream(request, carerJobStream);
    if (!auth.ok) {
      return auth.response;
    }

    console.info('[LIVE_STREAM_AUTH]', {
      channelType: carerJobStream.channelType,
      carerUid: auth.auth.uid,
      coadminUid: auth.auth.coadminUid,
      ...auth.auth.timing,
    });

    return createLiveStreamResponse(
      request,
      carerJobStream.channels,
      parseLastEventId(url.searchParams.get('lastEventId'))
    );
  }

  return apiError('Forbidden.', 403);
}

function createLiveStreamResponse(
  request: Request,
  allowedChannels: string[],
  lastEventId: number
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = lastEventId;
      let lastHeartbeatAt = Date.now();
      let closed = false;
      let pollInFlight = false;
      let wakeTimer: ReturnType<typeof setTimeout> | null = null;

      const clearWakeTimer = () => {
        if (wakeTimer) {
          clearTimeout(wakeTimer);
          wakeTimer = null;
        }
      };

      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearWakeTimer();
        try {
          controller.close();
        } catch {
          // Ignore close races.
        }
      };

      const enqueue = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };

      const waitForPollInterval = () =>
        new Promise<void>((resolve) => {
          if (closed || request.signal.aborted) {
            resolve();
            return;
          }
          clearWakeTimer();
          wakeTimer = setTimeout(() => {
            wakeTimer = null;
            resolve();
          }, POLL_INTERVAL_MS);
        });

      const pollOnce = async () => {
        if (closed || pollInFlight) return;
        pollInFlight = true;
        try {
          const rows = await getLiveOutboxRowsAfter(allowedChannels, cursor, 100);
          for (const row of rows) {
            enqueue(formatSseEvent(row));
            cursor = Math.max(cursor, row.outbox_id);
          }

          if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            enqueue(': heartbeat\n\n');
            lastHeartbeatAt = Date.now();
          }
        } catch (error) {
          console.info('[LIVE_OUTBOX] failed', { reason: 'sse_poll', error });
        } finally {
          pollInFlight = false;
        }
      };

      const pump = async () => {
        try {
          const replayRows = await getLiveOutboxRowsAfter(allowedChannels, cursor, 200);
          for (const row of replayRows) {
            enqueue(formatSseEvent(row));
            cursor = Math.max(cursor, row.outbox_id);
          }
        } catch (error) {
          console.info('[LIVE_OUTBOX] failed', { reason: 'sse_replay', error });
        }

        while (!closed && !request.signal.aborted) {
          await pollOnce();
          if (closed || request.signal.aborted) break;
          await waitForPollInterval();
        }
      };

      request.signal.addEventListener('abort', closeStream, { once: true });
      void pump().finally(closeStream);
    },
    cancel() {
      // Abort is wired once on request.signal; client disconnect triggers abort.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
