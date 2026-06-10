import 'server-only';

import type { PoolClient } from 'pg';

import {
  claimAuthorityOperation,
  readAuthorityOperationPayload,
} from '@/lib/sql/authorityLedger';
import { normalizeGameName } from '@/lib/sql/authorityGameRequestHelpers';
import {
  coadminTaskLiveChannel,
  insertLiveOutboxEventWithClient,
} from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export type PlayerCredentialTaskType = 'reset_password' | 'recreate_username';

function credentialTaskId(
  taskType: PlayerCredentialTaskType,
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  const normalized = normalizeGameName(gameName);
  return `${taskType}__${coadminUid}__${playerUid}__${normalized}`;
}

function buildPendingCredentialTaskRaw(input: {
  taskId: string;
  coadminUid: string;
  taskType: PlayerCredentialTaskType;
  playerUid: string;
  playerUsername: string;
  gameName: string;
  currentUsername?: string | null;
  nowIso: string;
}) {
  return {
    id: input.taskId,
    coadminUid: input.coadminUid,
    type: input.taskType,
    playerUid: input.playerUid,
    playerUsername: input.playerUsername || 'Player',
    gameName: input.gameName.trim(),
    amount: null,
    requestId: null,
    status: 'pending',
    assignedCarerUid: null,
    assignedCarer: null,
    assignedCarerUsername: null,
    claimedStatus: null,
    claimedAt: null,
    claimedByUid: null,
    claimedByUsername: null,
    startedAt: null,
    runningAt: null,
    expiresAt: null,
    completedAt: null,
    cancelledAt: null,
    failedAt: null,
    ttlExpiresAt: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
    automationStatus: null,
    automationJobId: null,
    linkedJobId: null,
    currentJobId: null,
    activeJobId: null,
    assignedJobStatus: null,
    automationError: null,
    error: null,
    failureReason: null,
    retryPending: true,
    resetToPendingAt: input.nowIso,
    returnedToPendingAt: input.nowIso,
    pendingSince: input.nowIso,
    lastHeartbeatAt: null,
    queuedAt: null,
    automationUpdatedAt: input.nowIso,
    updatedAt: input.nowIso,
    createdAt: input.nowIso,
    currentUsername: cleanText(input.currentUsername) || null,
    gameAccountUsername: cleanText(input.currentUsername) || null,
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
  } as Record<string, unknown>;
}

async function loadPlayerProfileInTxn(client: PoolClient, playerUid: string) {
  const { rows } = await client.query(
    `
      SELECT uid, username, role, status, coadmin_uid, created_by, raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1
        AND deleted_at IS NULL
      LIMIT 1
      FOR UPDATE
    `,
    [playerUid]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  const raw = (row.raw_firestore_data as Record<string, unknown>) || {};
  return {
    uid: cleanText(row.uid),
    username: cleanText(row.username) || 'Player',
    role: cleanText(row.role).toLowerCase(),
    status: (cleanText(row.status) || 'active').toLowerCase(),
    coadminUid:
      cleanText(row.coadmin_uid) ||
      cleanText(row.created_by) ||
      cleanText(raw.coadminUid) ||
      cleanText(raw.createdBy) ||
      '',
  };
}

async function loadPlayerGameLoginInTxn(
  client: PoolClient,
  input: {
    playerUid: string;
    gameName: string;
    gameLoginId?: string | null;
  }
) {
  const normalizedGame = normalizeGameName(input.gameName);
  if (input.gameLoginId) {
    const { rows } = await client.query(
      `
        SELECT firebase_id, player_uid, player_username, game_name, game_username,
               coadmin_uid, created_by
        FROM public.player_game_logins_cache
        WHERE firebase_id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [cleanText(input.gameLoginId)]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    if (cleanText(row.player_uid) !== input.playerUid) {
      throw new Error('Forbidden: game login does not belong to this player.');
    }
    return {
      id: cleanText(row.firebase_id),
      playerUid: cleanText(row.player_uid),
      playerUsername: cleanText(row.player_username) || 'Player',
      gameName: cleanText(row.game_name),
      gameUsername: cleanText(row.game_username),
      coadminUid: cleanText(row.coadmin_uid) || cleanText(row.created_by),
    };
  }

  const { rows } = await client.query(
    `
      SELECT firebase_id, player_uid, player_username, game_name, game_username,
             coadmin_uid, created_by
      FROM public.player_game_logins_cache
      WHERE player_uid = $1
        AND deleted_at IS NULL
        AND normalized_game_name = $2
      ORDER BY COALESCE(updated_at, created_at, mirrored_at) DESC
      LIMIT 1
    `,
    [input.playerUid, normalizedGame]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    id: cleanText(row.firebase_id),
    playerUid: cleanText(row.player_uid),
    playerUsername: cleanText(row.player_username) || 'Player',
    gameName: cleanText(row.game_name),
    gameUsername: cleanText(row.game_username),
    coadminUid: cleanText(row.coadmin_uid) || cleanText(row.created_by),
  };
}

async function upsertCredentialCarerTaskInTxn(
  client: PoolClient,
  input: {
    taskId: string;
    coadminUid: string;
    taskType: PlayerCredentialTaskType;
    playerUid: string;
    playerUsername: string;
    gameName: string;
    currentUsername?: string | null;
    nowIso: string;
  }
) {
  const raw = buildPendingCredentialTaskRaw(input);
  await client.query(
    `
      INSERT INTO public.carer_tasks_cache (
        firebase_id, coadmin_uid, type, player_uid, player_username, game_name,
        normalized_game_name, amount, request_id, status, current_username,
        game_account_username, retry_pending, created_at, updated_at, pending_since,
        reset_to_pending_at, returned_to_pending_at, automation_updated_at, source,
        mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, NULL, NULL, 'pending',
        NULLIF($8, ''), NULLIF($8, ''), TRUE,
        $9::timestamptz, $9::timestamptz, $9::timestamptz, $9::timestamptz,
        $9::timestamptz, $9::timestamptz, 'authority_player_credential', now(), NULL,
        $10::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        type = EXCLUDED.type,
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        game_name = EXCLUDED.game_name,
        normalized_game_name = EXCLUDED.normalized_game_name,
        status = EXCLUDED.status,
        current_username = EXCLUDED.current_username,
        game_account_username = EXCLUDED.game_account_username,
        retry_pending = EXCLUDED.retry_pending,
        updated_at = EXCLUDED.updated_at,
        pending_since = EXCLUDED.pending_since,
        reset_to_pending_at = EXCLUDED.reset_to_pending_at,
        returned_to_pending_at = EXCLUDED.returned_to_pending_at,
        automation_updated_at = EXCLUDED.automation_updated_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
      WHERE public.carer_tasks_cache.deleted_at IS NULL
    `,
    [
      input.taskId,
      input.coadminUid,
      input.taskType,
      input.playerUid,
      input.playerUsername,
      input.gameName.trim(),
      normalizeGameName(input.gameName),
      cleanText(input.currentUsername),
      input.nowIso,
      JSON.stringify(raw),
    ]
  );
}

export async function createPlayerCredentialTaskInSql(input: {
  playerUid: string;
  playerUsername?: string | null;
  gameName: string;
  taskType: PlayerCredentialTaskType;
  coadminUidHint?: string | null;
  gameLoginId?: string | null;
  idempotencyKey?: string | null;
}): Promise<{
  taskId: string;
  coadminUid: string;
  gameLoginId: string | null;
  insertedTask: boolean;
  outboxChannels: string[];
  duplicate?: boolean;
}> {
  const playerUid = cleanText(input.playerUid);
  const gameName = cleanText(input.gameName);
  const taskType = input.taskType;
  if (!playerUid || !gameName) {
    throw new Error('playerUid and gameName are required.');
  }
  if (taskType !== 'reset_password' && taskType !== 'recreate_username') {
    throw new Error('taskType must be reset_password or recreate_username.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('SQL pool unavailable.');
  }

  const normalizedGame = normalizeGameName(gameName);
  const operationKey =
    cleanText(input.idempotencyKey) ||
    `player_credential_task:${taskType}:${playerUid}:${normalizedGame}`;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const op = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'player_credential_task',
      userUid: playerUid,
      sourceId: `${taskType}:${normalizedGame}`,
      actorUid: playerUid,
      payload: {},
    });
    if (!op.claimed && op.duplicate) {
      const payload = await readAuthorityOperationPayload(operationKey);
      if (payload?.taskId) {
        await client.query('COMMIT');
        return {
          taskId: String(payload.taskId),
          coadminUid: String(payload.coadminUid || ''),
          gameLoginId: payload.gameLoginId ? String(payload.gameLoginId) : null,
          insertedTask: false,
          outboxChannels: Array.isArray(payload.outboxChannels)
            ? payload.outboxChannels.map(String)
            : [],
          duplicate: true,
        };
      }
    }

    const player = await loadPlayerProfileInTxn(client, playerUid);
    if (!player) {
      throw new Error('Player profile not found.');
    }
    if (player.status === 'disabled') {
      throw new Error('Your account is disabled.');
    }

    const gameLogin = await loadPlayerGameLoginInTxn(client, {
      playerUid,
      gameName,
      gameLoginId: input.gameLoginId,
    });
    if (!gameLogin) {
      throw new Error('Game login not found for this game.');
    }

    const coadminUid =
      cleanText(gameLogin.coadminUid) ||
      cleanText(input.coadminUidHint) ||
      cleanText(player.coadminUid);
    if (!coadminUid) {
      throw new Error('Player coadmin scope not found.');
    }

    const playerUsername =
      cleanText(input.playerUsername) ||
      cleanText(gameLogin.playerUsername) ||
      player.username;
    const taskId = credentialTaskId(taskType, coadminUid, playerUid, gameName);
    const nowIso = new Date().toISOString();

    await upsertCredentialCarerTaskInTxn(client, {
      taskId,
      coadminUid,
      taskType,
      playerUid,
      playerUsername,
      gameName,
      currentUsername: gameLogin.gameUsername,
      nowIso,
    });

    const outboxPayload = {
      entityId: taskId,
      taskId,
      coadminUid,
      playerUid,
      playerUsername,
      status: 'pending',
      type: taskType,
      gameName: gameName.trim(),
      currentUsername: cleanText(gameLogin.gameUsername) || null,
      updatedAt: nowIso,
      source: 'authority',
    };
    const outboxChannels = [coadminTaskLiveChannel(coadminUid)];
    await insertLiveOutboxEventWithClient(client, {
      channel: outboxChannels[0],
      eventType: 'task.upserted',
      entityType: 'carer_task',
      entityId: taskId,
      source: 'authority_player_credential',
      mirroredAt: nowIso,
      payload: outboxPayload,
    });

    await client.query(
      `
        UPDATE public.authority_operations
        SET payload = $2::jsonb
        WHERE operation_key = $1
      `,
      [
        operationKey,
        JSON.stringify({
          taskId,
          coadminUid,
          gameLoginId: gameLogin.id,
          outboxChannels,
        }),
      ]
    );

    await client.query('COMMIT');

    console.info('[PLAYER_CREDENTIAL_TASK_FLOW_AUDIT]', {
      taskId,
      taskType,
      playerUid,
      coadminUid,
      gameName: gameName.trim(),
      gameLoginId: gameLogin.id,
      requestStatus: 'pending',
      taskStatus: 'pending',
      insertedTask: true,
      outboxChannels,
      firestoreAttempted: false,
      reason: `player_${taskType}_create`,
    });

    return {
      taskId,
      coadminUid,
      gameLoginId: gameLogin.id,
      insertedTask: true,
      outboxChannels,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
