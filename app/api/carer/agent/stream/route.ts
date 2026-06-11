import { verifyAgentTickSecret } from '@/lib/automation/agentApiAuth';
import { apiError } from '@/lib/firebase/apiAuth';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { verifyAgentLinkedToCarerInSql } from '@/lib/sql/authorityAgentJobs';
import { agentJobLiveChannel, getLiveOutboxRowsAfter, type LiveOutboxRow } from '@/lib/sql/liveOutbox';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 25_000;

function parseLastEventId(raw: string | null) {
  const parsed = Number.parseInt(String(raw || '0'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatSseEvent(row: LiveOutboxRow) {
  return `id: ${row.outbox_id}\nevent: ${row.event_type}\ndata: ${JSON.stringify(row.payload)}\n\n`;
}

function formatPingEvent(channel: string) {
  return `event: ping\ndata: ${JSON.stringify({
    now: new Date().toISOString(),
    channel,
  })}\n\n`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const carerUid = cleanText(url.searchParams.get('carerUid'));
  const agentId = cleanText(url.searchParams.get('agentId'));
  const lastEventId = parseLastEventId(url.searchParams.get('lastEventId'));

  if (!isAuthoritySqlWriteEnabled()) {
    return apiError('SQL authority writes are disabled.', 503);
  }
  if (!verifyAgentTickSecret(request)) {
    return apiError('Unauthorized.', 401);
  }
  if (!carerUid || !agentId) {
    return apiError('carerUid and agentId are required.', 400);
  }

  try {
    await verifyAgentLinkedToCarerInSql(carerUid, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent is not linked to this carer.';
    return apiError(message, 403);
  }

  const channel = agentJobLiveChannel(carerUid, agentId);

  console.info('[AGENT_STREAM_SUBSCRIBE]', {
    carerUid,
    agentId,
    channel,
    lastEventId,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = lastEventId;
      let closed = false;
      let pollInFlight = false;
      let wakeTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const clearWakeTimer = () => {
        if (wakeTimer) {
          clearTimeout(wakeTimer);
          wakeTimer = null;
        }
      };

      const clearHeartbeatTimer = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      const closeStream = (reason: string) => {
        if (closed) return;
        closed = true;
        clearWakeTimer();
        clearHeartbeatTimer();
        console.info('[AGENT_STREAM_CLOSE]', {
          carerUid,
          agentId,
          channel,
          lastEventId: cursor,
          reason,
        });
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

      const sendHeartbeat = (phase: 'initial' | 'interval') => {
        if (closed) return;
        enqueue(formatPingEvent(channel));
        console.info('[AGENT_STREAM_HEARTBEAT]', {
          carerUid,
          agentId,
          channel,
          lastEventId: cursor,
          phase,
        });
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
          const rows = await getLiveOutboxRowsAfter([channel], cursor, 50);
          for (const row of rows) {
            if (row.event_type === 'job_available') {
              console.info('[AGENT_STREAM_EVENT_DELIVERED]', {
                outboxId: row.outbox_id,
                channel: row.channel,
                eventType: row.event_type,
                entityId: row.entity_id,
                jobId: row.payload?.jobId || null,
                taskId: row.payload?.taskId || null,
              });
            }
            enqueue(formatSseEvent(row));
            cursor = Math.max(cursor, row.outbox_id);
          }
        } catch (error) {
          console.info('[AGENT_STREAM_ERROR]', {
            phase: 'poll',
            carerUid,
            agentId,
            channel,
            lastEventId: cursor,
            error,
          });
        } finally {
          pollInFlight = false;
        }
      };

      const pump = async () => {
        try {
          const replayRows = await getLiveOutboxRowsAfter([channel], cursor, 100);
          for (const row of replayRows) {
            if (row.event_type === 'job_available') {
              console.info('[AGENT_STREAM_EVENT_DELIVERED]', {
                outboxId: row.outbox_id,
                channel: row.channel,
                eventType: row.event_type,
                entityId: row.entity_id,
                jobId: row.payload?.jobId || null,
                taskId: row.payload?.taskId || null,
                phase: 'replay',
              });
            }
            enqueue(formatSseEvent(row));
            cursor = Math.max(cursor, row.outbox_id);
          }
        } catch (error) {
          console.info('[AGENT_STREAM_ERROR]', {
            phase: 'replay',
            carerUid,
            agentId,
            channel,
            lastEventId: cursor,
            error,
          });
        }

        sendHeartbeat('initial');
        heartbeatTimer = setInterval(() => {
          sendHeartbeat('interval');
        }, HEARTBEAT_INTERVAL_MS);

        while (!closed && !request.signal.aborted) {
          await pollOnce();
          if (closed || request.signal.aborted) break;
          await waitForPollInterval();
        }
      };

      request.signal.addEventListener('abort', () => closeStream('client_abort'), { once: true });
      void pump().finally(() => closeStream('pump_finished'));
    },
    cancel() {
      // Abort is wired once on request.signal.
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
