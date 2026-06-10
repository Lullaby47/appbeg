import 'server-only';

import type { PoolClient } from 'pg';

import {
  buildPendingRequestLinkedCarerTaskPayload,
  requestLinkedCarerTaskId,
  type RequestLinkedCarerTaskInput,
} from '@/lib/games/requestLinkedCarerTask';
import { cleanText, toIsoString } from '@/lib/sql/playerMirrorCommon';
import {
  carerTaskLiveChannel,
  coadminTaskLiveChannel,
  insertLiveOutboxEventWithClient,
  playerRequestLiveChannel,
} from '@/lib/sql/liveOutbox';

export function normalizeGameName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

export function ttlAfterDaysIso(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function updatePlayerBalancesInTxn(
  client: PoolClient,
  uid: string,
  input: {
    coin?: number;
    cash?: number;
    cashBoxNpr?: number;
    promoLockedCoins?: number;
    firstRechargeMatchUsed?: boolean;
    rawPatch?: Record<string, unknown>;
  }
) {
  const nowIso = new Date().toISOString();
  const rawPatch: Record<string, unknown> = { ...(input.rawPatch || {}) };
  if (input.coin != null) rawPatch.coin = input.coin;
  if (input.cash != null) rawPatch.cash = input.cash;
  if (input.cashBoxNpr != null) rawPatch.cashBoxNpr = input.cashBoxNpr;
  if (input.promoLockedCoins != null) rawPatch.promoLockedCoins = input.promoLockedCoins;
  if (input.firstRechargeMatchUsed === true) {
    rawPatch.firstRechargeMatchUsed = true;
    rawPatch.firstRechargeMatchUsedAt = nowIso;
  }

  if (
    input.coin != null ||
    input.cash != null ||
    input.promoLockedCoins != null ||
    input.firstRechargeMatchUsed === true ||
    Object.keys(input.rawPatch || {}).length > 0
  ) {
    const sets: string[] = ['updated_at = $2::timestamptz'];
    const params: unknown[] = [uid, nowIso];
    let idx = 3;
    if (input.coin != null) {
      sets.push(`coin = $${idx}`);
      params.push(input.coin);
      idx += 1;
    }
    if (input.cash != null) {
      sets.push(`cash = $${idx}`);
      params.push(input.cash);
      idx += 1;
    }
    if (input.promoLockedCoins != null) {
      sets.push(`promo_locked_coins = $${idx}`);
      params.push(input.promoLockedCoins);
      idx += 1;
    }
    sets.push(
      `raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $${idx}::jsonb`
    );
    params.push(JSON.stringify(rawPatch));
    await client.query(
      `UPDATE public.players_cache SET ${sets.join(', ')} WHERE uid = $1 AND deleted_at IS NULL`,
      params
    );
  }

  if (
    input.coin != null ||
    input.cash != null ||
    input.cashBoxNpr != null ||
    input.promoLockedCoins != null ||
    Object.keys(input.rawPatch || {}).length > 0
  ) {
    const snapSets: string[] = ['updated_at = $2::timestamptz', 'mirrored_at = now()'];
    const snapParams: unknown[] = [uid, nowIso];
    let idx = 3;
    if (input.coin != null) {
      snapSets.push(`coin = $${idx}`);
      snapParams.push(input.coin);
      idx += 1;
    }
    if (input.cash != null) {
      snapSets.push(`cash = $${idx}`);
      snapParams.push(input.cash);
      idx += 1;
    }
    if (input.cashBoxNpr != null) {
      snapSets.push(`cash_box_npr = $${idx}`);
      snapParams.push(input.cashBoxNpr);
      idx += 1;
    }
    if (input.promoLockedCoins != null) {
      snapSets.push(`promo_locked_coins = $${idx}`);
      snapParams.push(input.promoLockedCoins);
      idx += 1;
    }
    snapSets.push(
      `raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $${idx}::jsonb`
    );
    snapParams.push(JSON.stringify(rawPatch));
    await client.query(
      `UPDATE public.user_balance_snapshots_cache SET ${snapSets.join(', ')} WHERE firebase_id = $1 AND deleted_at IS NULL`,
      snapParams
    );
  }
}

export async function patchPlayerReferralFieldsInTxn(
  client: PoolClient,
  uid: string,
  input: {
    referralRewardStatus?: string;
    referralQualifiedAt?: string;
    rawPatch?: Record<string, unknown>;
  }
) {
  const nowIso = new Date().toISOString();
  const rawPatch: Record<string, unknown> = { ...(input.rawPatch || {}) };
  if (input.referralRewardStatus != null) {
    rawPatch.referralRewardStatus = input.referralRewardStatus;
  }
  if (input.referralQualifiedAt != null) {
    rawPatch.referralQualifiedAt = input.referralQualifiedAt;
  }

  const sets = ['updated_at = $2::timestamptz'];
  const params: unknown[] = [uid, nowIso];
  let idx = 3;
  if (input.referralRewardStatus != null) {
    sets.push(`referral_reward_status = $${idx}`);
    params.push(input.referralRewardStatus);
    idx += 1;
  }
  if (input.referralQualifiedAt != null) {
    sets.push(`referral_qualified_at = $${idx}::timestamptz`);
    params.push(input.referralQualifiedAt);
    idx += 1;
  }
  sets.push(`raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $${idx}::jsonb`);
  params.push(JSON.stringify(rawPatch));
  await client.query(
    `UPDATE public.players_cache SET ${sets.join(', ')} WHERE uid = $1 AND deleted_at IS NULL`,
    params
  );
}

export async function upsertGameRequestCacheInTxn(
  client: PoolClient,
  requestId: string,
  input: Record<string, unknown>
) {
  const raw = (input.rawFirestoreData || input) as Record<string, unknown>;
  const gameName = cleanText(input.gameName);
  await client.query(
    `
      INSERT INTO public.player_game_requests_cache (
        firebase_id, player_uid, player_username, coadmin_uid, created_by,
        game_name, normalized_game_name, current_username, game_account_username,
        type, status, amount, base_amount, bonus_percentage, bonus_event_id,
        first_recharge_match_applied, coin_deducted_on_request,
        coin_refunded_on_dismissal, coin_refunded_on_dismissal_at, task_id,
        poke_message, created_at, updated_at, completed_at, poked_at, dismissed_at,
        ttl_expires_at, dismiss_type, source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
        NULLIF($10, ''), NULLIF($11, ''), $12, $13, $14, NULLIF($15, ''),
        $16, $17, $18, $19::timestamptz, NULLIF($20, ''),
        NULLIF($21, ''), $22::timestamptz, $23::timestamptz, $24::timestamptz, $25::timestamptz,
        $26::timestamptz, $27::timestamptz, NULLIF($28, ''), $29, now(), NULL, $30::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        coadmin_uid = EXCLUDED.coadmin_uid,
        created_by = EXCLUDED.created_by,
        game_name = EXCLUDED.game_name,
        normalized_game_name = EXCLUDED.normalized_game_name,
        current_username = EXCLUDED.current_username,
        game_account_username = EXCLUDED.game_account_username,
        type = EXCLUDED.type,
        status = EXCLUDED.status,
        amount = EXCLUDED.amount,
        base_amount = EXCLUDED.base_amount,
        bonus_percentage = EXCLUDED.bonus_percentage,
        bonus_event_id = EXCLUDED.bonus_event_id,
        first_recharge_match_applied = EXCLUDED.first_recharge_match_applied,
        coin_deducted_on_request = EXCLUDED.coin_deducted_on_request,
        coin_refunded_on_dismissal = EXCLUDED.coin_refunded_on_dismissal,
        coin_refunded_on_dismissal_at = EXCLUDED.coin_refunded_on_dismissal_at,
        task_id = EXCLUDED.task_id,
        poke_message = EXCLUDED.poke_message,
        created_at = COALESCE(public.player_game_requests_cache.created_at, EXCLUDED.created_at),
        updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at,
        poked_at = EXCLUDED.poked_at,
        dismissed_at = EXCLUDED.dismissed_at,
        ttl_expires_at = EXCLUDED.ttl_expires_at,
        dismiss_type = EXCLUDED.dismiss_type,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      requestId,
      cleanText(input.playerUid),
      cleanText(input.playerUsername),
      cleanText(input.coadminUid),
      cleanText(input.createdBy || input.coadminUid),
      gameName,
      normalizeGameName(gameName),
      cleanText(input.currentUsername),
      cleanText(input.gameAccountUsername || input.currentUsername),
      cleanText(input.type),
      cleanText(input.status),
      input.amount == null ? null : Number(input.amount),
      input.baseAmount == null ? null : Number(input.baseAmount),
      input.bonusPercentage == null ? null : Number(input.bonusPercentage),
      cleanText(input.bonusEventId),
      input.firstRechargeMatchApplied === true,
      input.coinDeductedOnRequest === true,
      input.coinRefundedOnDismissal === true,
      toIsoString(input.coinRefundedOnDismissalAt),
      requestLinkedCarerTaskId(requestId),
      cleanText(input.pokeMessage),
      toIsoString(input.createdAt),
      toIsoString(input.updatedAt || input.createdAt),
      toIsoString(input.completedAt),
      toIsoString(input.pokedAt),
      toIsoString(input.dismissedAt || input.completedAt),
      toIsoString(input.ttlExpiresAt),
      cleanText(input.dismissType),
      cleanText(input.source) || 'authority',
      JSON.stringify(raw),
    ]
  );
}

function buildCarerTaskSqlPayload(input: RequestLinkedCarerTaskInput, nowIso: string) {
  const firestorePayload = buildPendingRequestLinkedCarerTaskPayload({
    ...input,
    createdAt: nowIso,
  }) as Record<string, unknown>;
  return {
    ...firestorePayload,
    createdAt: nowIso,
    updatedAt: nowIso,
    pendingSince: nowIso,
    resetToPendingAt: nowIso,
    returnedToPendingAt: nowIso,
    automationUpdatedAt: nowIso,
  } as Record<string, unknown>;
}

export async function upsertLinkedCarerTaskInTxn(
  client: PoolClient,
  input: RequestLinkedCarerTaskInput,
  nowIso: string
) {
  const taskId = requestLinkedCarerTaskId(input.requestId);
  const raw = buildCarerTaskSqlPayload(input, nowIso);
  await client.query(
    `
      INSERT INTO public.carer_tasks_cache (
        firebase_id, coadmin_uid, type, player_uid, player_username, game_name,
        normalized_game_name, amount, request_id, status, current_username,
        game_account_username, login_url, game_login_url, lobby_url, site_url, base_url,
        game_credential_username, game_credential_password, is_poked, poke_message,
        retry_pending, created_at, updated_at, pending_since, reset_to_pending_at,
        returned_to_pending_at, automation_updated_at, source, mirrored_at, deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
        NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''),
        NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''), NULLIF($17, ''),
        NULLIF($18, ''), NULLIF($19, ''), FALSE, NULL, TRUE,
        $20::timestamptz, $20::timestamptz, $20::timestamptz, $20::timestamptz,
        $20::timestamptz, $20::timestamptz, 'authority', now(), NULL, $21::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        type = EXCLUDED.type,
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        game_name = EXCLUDED.game_name,
        normalized_game_name = EXCLUDED.normalized_game_name,
        amount = EXCLUDED.amount,
        request_id = EXCLUDED.request_id,
        status = EXCLUDED.status,
        current_username = EXCLUDED.current_username,
        game_account_username = EXCLUDED.game_account_username,
        login_url = EXCLUDED.login_url,
        game_login_url = EXCLUDED.game_login_url,
        lobby_url = EXCLUDED.lobby_url,
        site_url = EXCLUDED.site_url,
        base_url = EXCLUDED.base_url,
        game_credential_username = EXCLUDED.game_credential_username,
        game_credential_password = EXCLUDED.game_credential_password,
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
    `,
    [
      taskId,
      input.coadminUid,
      input.type,
      input.playerUid,
      cleanText(input.playerUsername) || 'Player',
      input.gameName,
      normalizeGameName(input.gameName),
      input.amount,
      input.requestId,
      'pending',
      cleanText(input.currentUsername),
      cleanText(input.currentUsername),
      cleanText(raw.loginUrl),
      cleanText(raw.gameLoginUrl),
      cleanText(raw.lobbyUrl),
      cleanText(raw.siteUrl),
      cleanText(raw.baseUrl),
      cleanText(raw.gameCredentialUsername),
      cleanText(raw.gameCredentialPassword),
      nowIso,
      JSON.stringify(raw),
    ]
  );
  return taskId;
}

export async function tombstoneLinkedCarerTaskInTxn(
  client: PoolClient,
  requestId: string,
  source = 'authority'
) {
  const taskId = requestLinkedCarerTaskId(requestId);
  const nowIso = new Date().toISOString();
  const taskResult = await client.query(
    `
      SELECT coadmin_uid, assigned_carer_uid, claimed_by_uid
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1 AND deleted_at IS NULL
      FOR UPDATE
    `,
    [taskId]
  );
  if (!taskResult.rows.length) {
    return taskId;
  }

  const task = taskResult.rows[0] as Record<string, unknown>;
  await client.query(
    `
      UPDATE public.carer_tasks_cache
      SET deleted_at = now(), mirrored_at = now(), source = $2
      WHERE firebase_id = $1
    `,
    [taskId, source]
  );

  const payload = {
    entityId: taskId,
    taskId,
    requestId,
    status: 'tombstoned',
    updatedAt: nowIso,
    source: 'authority',
  };
  const coadminUid = cleanText(task.coadmin_uid);
  const carerUid = cleanText(task.assigned_carer_uid) || cleanText(task.claimed_by_uid);
  if (coadminUid) {
    await insertLiveOutboxEventWithClient(client, {
      channel: coadminTaskLiveChannel(coadminUid),
      eventType: 'task.tombstoned',
      entityType: 'carer_task',
      entityId: taskId,
      source,
      mirroredAt: nowIso,
      payload,
    });
  }
  if (carerUid) {
    await insertLiveOutboxEventWithClient(client, {
      channel: carerTaskLiveChannel(carerUid),
      eventType: 'task.tombstoned',
      entityType: 'carer_task',
      entityId: taskId,
      source,
      mirroredAt: nowIso,
      payload,
    });
  }
  return taskId;
}

export async function writeGameRequestOutboxInTxn(
  client: PoolClient,
  input: {
    playerUid: string;
    coadminUid: string;
    requestId: string;
    type: string;
    status: string;
    gameName: string;
    amount: number;
    eventType: string;
    updatedAt: string;
  }
) {
  const payload = {
    entityId: input.requestId,
    playerUid: input.playerUid,
    requestId: input.requestId,
    type: input.type,
    status: input.status,
    gameName: input.gameName,
    amount: input.amount,
    updatedAt: input.updatedAt,
    source: 'authority',
  };
  await insertLiveOutboxEventWithClient(client, {
    channel: playerRequestLiveChannel(input.playerUid),
    eventType: input.eventType,
    entityType: 'player_game_request',
    entityId: input.requestId,
    source: 'authority_game_request',
    mirroredAt: input.updatedAt,
    payload,
  });
  await insertLiveOutboxEventWithClient(client, {
    channel: coadminTaskLiveChannel(input.coadminUid),
    eventType: input.eventType,
    entityType: 'player_game_request',
    entityId: input.requestId,
    source: 'authority_game_request',
    mirroredAt: input.updatedAt,
    payload,
  });
}
