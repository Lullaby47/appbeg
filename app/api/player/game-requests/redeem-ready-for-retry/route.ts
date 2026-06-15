import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import {
  carerTaskLiveChannel,
  coadminTaskLiveChannel,
  insertLiveOutboxEventWithClient,
  playerRequestLiveChannel,
} from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

const PLAYER_EXIT_MESSAGE =
  'Please exit the game first. Your redeem is waiting and will continue automatically.';

function parseJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function isWaitingPlayerExit(row: Record<string, unknown>) {
  const raw = parseJson(row.raw_firestore_data);
  const status = cleanText(row.status).toLowerCase();
  const automationStatus = cleanText(row.automation_status || raw.automationStatus).toUpperCase();
  return status === 'waiting_player_exit' || automationStatus === 'PLAYER_ACTIVE_IN_GAME';
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as { requestId?: unknown };
    const requestId = cleanText(body.requestId);
    if (!requestId) {
      return apiError('requestId is required.', 400);
    }
    if (!isAuthoritySqlWriteEnabled()) {
      return apiError('SQL authority writes are disabled.', 503);
    }
    const db = getPlayerMirrorPool();
    if (!db) {
      return apiError('SQL pool unavailable.', 503);
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const requestResult = await client.query(
        `SELECT * FROM public.player_game_requests_cache WHERE firebase_id = $1 FOR UPDATE`,
        [requestId]
      );
      if (!requestResult.rows.length) {
        throw new Error('Redeem request not found.');
      }
      const requestRow = requestResult.rows[0] as Record<string, unknown>;
      if (cleanText(requestRow.player_uid) !== auth.user.uid) {
        throw new Error('Forbidden.');
      }
      if (cleanText(requestRow.type).toLowerCase() !== 'redeem') {
        throw new Error('Only redeem requests can be retried this way.');
      }
      if (!isWaitingPlayerExit(requestRow)) {
        throw new Error('Redeem request is not waiting for player exit.');
      }

      const raw = parseJson(requestRow.raw_firestore_data);
      const retryAttempt = Math.max(0, Number(raw.retryAttempt || 0) || 0) + 1;
      const nowIso = new Date().toISOString();
      const taskId = cleanText(requestRow.task_id) || `request__${requestId}`;
      const coadminUid = cleanText(requestRow.coadmin_uid || raw.coadminUid);
      const gameName = cleanText(requestRow.game_name || raw.gameName);
      const amount = Number(requestRow.amount || raw.amount || 0);
      const carerUid = cleanText(raw.assignedCarerUid || raw.carerUid || requestRow.created_by);
      const requestPatch = {
        status: 'pending',
        automationStatus: 'retry_requested',
        playerMessage: null,
        pokeMessage: null,
        retryAttempt,
        retryPending: true,
        updatedAt: nowIso,
      };
      await client.query(
        `
          UPDATE public.player_game_requests_cache SET
            status = 'pending',
            automation_status = 'retry_requested',
            poke_message = NULL,
            retry_pending = TRUE,
            retryable_failure = FALSE,
            updated_at = $2::timestamptz,
            raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $3::jsonb,
            source = 'player_redeem_ready_for_retry',
            mirrored_at = now(),
            deleted_at = NULL
          WHERE firebase_id = $1
        `,
        [requestId, nowIso, JSON.stringify(requestPatch)]
      );
      await client.query(
        `
          UPDATE public.carer_tasks_cache SET
            status = 'pending',
            claimed_status = NULL,
            claimed_by_uid = NULL,
            claimed_by_username = NULL,
            automation_status = 'retry_requested',
            automation_error = NULL,
            automation_job_id = NULL,
            linked_job_id = NULL,
            retry_pending = TRUE,
            updated_at = $2::timestamptz,
            raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $3::jsonb,
            source = 'player_redeem_ready_for_retry',
            mirrored_at = now(),
            deleted_at = NULL
          WHERE firebase_id = $1
        `,
        [
          taskId,
          nowIso,
          JSON.stringify({
            status: 'pending',
            claimedStatus: null,
            claimedByUid: null,
            claimedByUsername: null,
            automationStatus: 'retry_requested',
            automationError: null,
            automationJobId: null,
            linkedJobId: null,
            retryPending: true,
            retryAttempt,
            updatedAt: nowIso,
          }),
        ]
      );
      await client.query(
        `
          UPDATE public.automation_jobs_cache SET
            status = 'cancelled',
            claimed_status = 'cancelled',
            cancelled_reason = 'player_exit_confirmed_retry_requested',
            updated_at = $2::timestamptz,
            completed_at = COALESCE(completed_at, $2::timestamptz),
            raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $3::jsonb
          WHERE task_id = $1
            AND deleted_at IS NULL
            AND status IN ('queued', 'running')
        `,
        [taskId, nowIso, JSON.stringify({ cancelledReason: 'player_exit_confirmed_retry_requested', updatedAt: nowIso })]
      );

      await insertLiveOutboxEventWithClient(client, {
        channel: playerRequestLiveChannel(auth.user.uid),
        eventType: 'request.upserted',
        entityType: 'player_game_request',
        entityId: requestId,
        source: 'player_redeem_ready_for_retry',
        mirroredAt: nowIso,
        payload: {
          entityId: requestId,
          requestId,
          playerUid: auth.user.uid,
          gameName,
          type: 'redeem',
          status: 'pending',
          automationStatus: 'retry_requested',
          retryAttempt,
          amount,
          updatedAt: nowIso,
        },
      });
      if (coadminUid) {
        const taskPayload = {
          entityId: taskId,
          taskId,
          requestId,
          coadminUid,
          carerUid: carerUid || null,
          status: 'pending',
          type: 'redeem',
          gameName,
          automationStatus: 'retry_requested',
          updatedAt: nowIso,
        };
        await insertLiveOutboxEventWithClient(client, {
          channel: coadminTaskLiveChannel(coadminUid),
          eventType: 'task.retry_requested',
          entityType: 'carer_task',
          entityId: taskId,
          source: 'player_redeem_ready_for_retry',
          mirroredAt: nowIso,
          payload: taskPayload,
        });
        if (carerUid) {
          await insertLiveOutboxEventWithClient(client, {
            channel: carerTaskLiveChannel(carerUid),
            eventType: 'task.retry_requested',
            entityType: 'carer_task',
            entityId: taskId,
            source: 'player_redeem_ready_for_retry',
            mirroredAt: nowIso,
            payload: taskPayload,
          });
        }
      }
      await client.query('COMMIT');
      console.info('[PLAYER_EXIT_CONFIRMED_RETRY_REQUESTED]', { requestId, playerUid: auth.user.uid, retryAttempt });
      console.info('[REDEEM_RETRY_AFTER_PLAYER_EXIT]', { requestId, taskId, retryAttempt });
      return NextResponse.json({
        success: true,
        request: {
          id: requestId,
          playerUid: auth.user.uid,
          gameName,
          type: 'redeem',
          status: 'pending',
          automationStatus: 'retry_requested',
          retryAttempt,
          amount,
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to mark redeem ready for retry.';
    const status = /not authenticated|authorization|token/i.test(message)
      ? 401
      : /forbidden/i.test(message)
        ? 403
        : /not found|not waiting|only redeem|requestId/i.test(message)
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
