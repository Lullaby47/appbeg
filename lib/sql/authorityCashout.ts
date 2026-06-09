import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { evaluateWithdrawalPolicy } from '@/lib/economy/policy';
import { getCoadminMaintenanceBreak } from '@/lib/maintenance/admin';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  readAuthorityOperationPayload,
} from '@/lib/sql/authorityLedger';
import {
  coadminCashoutLiveChannel,
  insertLiveOutboxEventWithClient,
  playerCashoutLiveChannel,
} from '@/lib/sql/liveOutbox';

const PLAYER_CASHOUT_MAX_NPR_PER_24_H = 1000;
const PLAYER_CASHOUT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AuthorityCashoutCreateInput = {
  playerUid: string;
  playerUsername?: string | null;
  paymentDetails: string;
  payoutMethod?: string | null;
  qrImageUrl?: string | null;
  paymentAppName?: string | null;
  paymentAppCashTag?: string | null;
  paymentAppAccountName?: string | null;
  idempotencyKey?: string | null;
};

export type AuthorityCashoutCreateResult = {
  success: true;
  duplicate: boolean;
  taskId: string;
};

export type AuthorityCashoutCompleteInput = {
  taskId: string;
  actorUid: string;
  actorUsername?: string | null;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
};

export type AuthorityCashoutCompleteResult = {
  success: true;
  duplicate: boolean;
  alreadyCompleted: boolean;
  taskId: string;
};

export type AuthorityCashoutDeclineInput = {
  taskId: string;
  actorUid: string;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
  idempotencyKey?: string | null;
};

export type AuthorityCashoutDeclineResult = {
  success: true;
  duplicate: boolean;
  taskId: string;
  refunded: boolean;
};

export type AuthorityCashoutStartInput = {
  taskId: string;
  actorUid: string;
  actorUsername?: string | null;
  actorRole: string;
  isAdmin: boolean;
  scopeUid: string | null;
};

export type AuthorityCashoutStartResult = {
  success: true;
  duplicate: boolean;
  taskId: string;
  expiresAtMs: number;
};

const CASHOUT_TASK_DURATION_MS = 3 * 60 * 1000;

function ttlAfterDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function readRawField(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return (raw as Record<string, unknown>)[field];
}

function readCashBoxNpr(snapshot: Record<string, unknown>, playerRow?: Record<string, unknown>) {
  const fromSnapshot = Number(snapshot.cash_box_npr);
  if (Number.isFinite(fromSnapshot)) return Math.max(0, fromSnapshot);
  const raw = playerRow?.raw_firestore_data ?? snapshot.raw_firestore_data;
  const fromRaw = Number(readRawField(raw, 'cashBoxNpr'));
  return Number.isFinite(fromRaw) ? Math.max(0, fromRaw) : 0;
}

function readRewardBlocked(snapshot: Record<string, unknown>, playerRow?: Record<string, unknown>) {
  if (typeof snapshot.reward_blocked === 'boolean') return snapshot.reward_blocked;
  const raw = playerRow?.raw_firestore_data ?? snapshot.raw_firestore_data;
  return readRawField(raw, 'rewardBlocked') === true;
}

async function fetchRolling24hCashoutUsageNpr(client: PoolClient, playerUid: string) {
  const since = new Date(Date.now() - PLAYER_CASHOUT_ROLLING_WINDOW_MS).toISOString();
  const result = await client.query(
    `
      SELECT amount_npr, status
      FROM public.player_cashout_tasks_cache
      WHERE player_uid = $1
        AND deleted_at IS NULL
        AND created_at >= $2::timestamptz
    `,
    [playerUid, since]
  );
  let total = 0;
  for (const row of result.rows) {
    if (cleanText((row as Record<string, unknown>).status).toLowerCase() === 'declined') continue;
    total += Math.max(0, Number((row as Record<string, unknown>).amount_npr || 0));
  }
  return total;
}

async function fetchCompletedCashoutCount(client: PoolClient, playerUid: string) {
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS count
      FROM public.player_cashout_tasks_cache
      WHERE player_uid = $1
        AND deleted_at IS NULL
        AND status = 'completed'
    `,
    [playerUid]
  );
  return Number(result.rows[0]?.count || 0);
}

async function fetchLatestCompletedRechargeAmount(client: PoolClient, playerUid: string) {
  const result = await client.query(
    `
      SELECT amount, base_amount, completed_at
      FROM public.player_game_requests_cache
      WHERE player_uid = $1
        AND deleted_at IS NULL
        AND type = 'recharge'
        AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST
      LIMIT 1
    `,
    [playerUid]
  );
  if (!result.rows.length) return 0;
  const row = result.rows[0] as Record<string, unknown>;
  return Math.max(0, Math.round(Number(row.base_amount ?? row.amount ?? 0)));
}

async function upsertCashoutTaskCache(client: PoolClient, taskId: string, input: Record<string, unknown>) {
  const raw = (input.rawFirestoreData || input) as Record<string, unknown>;
  await client.query(
    `
      INSERT INTO public.player_cashout_tasks_cache (
        firebase_id, coadmin_uid, player_uid, player_username, amount_npr,
        payment_details, payout_method, qr_image_url, payment_app_name,
        payment_app_cash_tag, payment_app_account_name, cash_deducted_on_request,
        status, assigned_handler_uid, assigned_handler_username,
        cashout_requested_by_staff_id, reward_npr_applied,
        reward_blocked_applied, declined_by_uids, started_at, expires_at,
        created_at, completed_at, source, mirrored_at, deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5,
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
        NULLIF($10, ''), NULLIF($11, ''), $12, NULLIF($13, ''),
        NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''), $17,
        $18, $19::jsonb, $20::timestamptz, $21::timestamptz,
        $22::timestamptz, $23::timestamptz, $24, now(), NULL,
        $25::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        amount_npr = EXCLUDED.amount_npr,
        payment_details = EXCLUDED.payment_details,
        payout_method = EXCLUDED.payout_method,
        qr_image_url = EXCLUDED.qr_image_url,
        payment_app_name = EXCLUDED.payment_app_name,
        payment_app_cash_tag = EXCLUDED.payment_app_cash_tag,
        payment_app_account_name = EXCLUDED.payment_app_account_name,
        cash_deducted_on_request = EXCLUDED.cash_deducted_on_request,
        status = EXCLUDED.status,
        assigned_handler_uid = EXCLUDED.assigned_handler_uid,
        assigned_handler_username = EXCLUDED.assigned_handler_username,
        cashout_requested_by_staff_id = EXCLUDED.cashout_requested_by_staff_id,
        reward_npr_applied = EXCLUDED.reward_npr_applied,
        reward_blocked_applied = EXCLUDED.reward_blocked_applied,
        declined_by_uids = EXCLUDED.declined_by_uids,
        started_at = EXCLUDED.started_at,
        expires_at = EXCLUDED.expires_at,
        created_at = COALESCE(public.player_cashout_tasks_cache.created_at, EXCLUDED.created_at),
        completed_at = EXCLUDED.completed_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      taskId,
      cleanText(input.coadminUid),
      cleanText(input.playerUid),
      cleanText(input.playerUsername),
      Number(input.amountNpr ?? 0),
      cleanText(input.paymentDetails),
      cleanText(input.payoutMethod),
      cleanText(input.qrImageUrl),
      cleanText(input.paymentAppName),
      cleanText(input.paymentAppCashTag),
      cleanText(input.paymentAppAccountName),
      input.cashDeductedOnRequest === true,
      cleanText(input.status),
      cleanText(input.assignedHandlerUid),
      cleanText(input.assignedHandlerUsername),
      cleanText(input.cashoutRequestedByStaffId),
      input.rewardNprApplied == null ? null : Number(input.rewardNprApplied),
      typeof input.rewardBlockedApplied === 'boolean' ? input.rewardBlockedApplied : null,
      JSON.stringify(Array.isArray(input.declinedByUids) ? input.declinedByUids : null),
      toIsoString(input.startedAt),
      toIsoString(input.expiresAt),
      toIsoString(input.createdAt),
      toIsoString(input.completedAt),
      cleanText(input.source) || 'authority',
      JSON.stringify(raw),
    ]
  );
}

async function updateBalances(
  client: PoolClient,
  uid: string,
  input: { cash?: number; coin?: number; cashBoxNpr?: number }
) {
  const nowIso = new Date().toISOString();
  if (input.cash != null) {
    await client.query(
      `
        UPDATE public.players_cache
        SET
          cash = $2,
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('cash', $2)
        WHERE uid = $1 AND deleted_at IS NULL
      `,
      [uid, input.cash, nowIso]
    );
    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          cash = $2,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('cash', $2)
        WHERE firebase_id = $1 AND deleted_at IS NULL
      `,
      [uid, input.cash, nowIso]
    );
  }
  if (input.cashBoxNpr != null) {
    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          cash_box_npr = $2,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('cashBoxNpr', $2)
        WHERE firebase_id = $1 AND deleted_at IS NULL
      `,
      [uid, input.cashBoxNpr, nowIso]
    );
    await client.query(
      `
        UPDATE public.players_cache
        SET
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('cashBoxNpr', $2)
        WHERE uid = $1 AND deleted_at IS NULL
      `,
      [uid, input.cashBoxNpr, nowIso]
    );
  }
}

async function writeCashoutOutbox(
  client: PoolClient,
  input: {
    playerUid: string;
    coadminUid: string;
    taskId: string;
    status: string;
    amountNpr: number;
    eventType: string;
    updatedAt: string;
  }
) {
  const payload = {
    entityId: input.taskId,
    taskId: input.taskId,
    playerUid: input.playerUid,
    coadminUid: input.coadminUid,
    status: input.status,
    amountNpr: input.amountNpr,
    updatedAt: input.updatedAt,
    source: 'authority',
  };
  await insertLiveOutboxEventWithClient(client, {
    channel: playerCashoutLiveChannel(input.playerUid),
    eventType: input.eventType,
    entityType: 'player_cashout_task',
    entityId: input.taskId,
    source: 'authority_cashout',
    mirroredAt: input.updatedAt,
    payload,
  });
  await insertLiveOutboxEventWithClient(client, {
    channel: coadminCashoutLiveChannel(input.coadminUid),
    eventType: input.eventType,
    entityType: 'player_cashout_task',
    entityId: input.taskId,
    source: 'authority_cashout',
    mirroredAt: input.updatedAt,
    payload,
  });
}

export async function createPlayerCashoutTaskInSql(
  input: AuthorityCashoutCreateInput
): Promise<AuthorityCashoutCreateResult> {
  const playerUid = cleanText(input.playerUid);
  const paymentDetails = cleanText(input.paymentDetails);
  const idempotencyKey = cleanText(input.idempotencyKey);
  if (!playerUid) throw new Error('Player profile not found.');
  if (paymentDetails.length < 5) throw new Error('Please provide clear payment details.');

  const resolvedIdempotencyKey = idempotencyKey || randomUUID();
  const operationKey = `cashout_create:${playerUid}:${resolvedIdempotencyKey}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.taskId) {
    return {
      success: true,
      duplicate: true,
      taskId: cleanText(existing.taskId),
    };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const taskId = randomUUID();
  const eventId = randomUUID();
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_create',
      userUid: playerUid,
      sourceId: taskId,
      actorUid: playerUid,
      actorRole: 'player',
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      if (payload?.taskId) {
        return { success: true, duplicate: true, taskId: cleanText(payload.taskId) };
      }
      throw new Error('Duplicate cashout create idempotency conflict.');
    }

    const [rollingUsed, completedCashoutCount, lastRechargeAmountNpr] = await Promise.all([
      fetchRolling24hCashoutUsageNpr(client, playerUid),
      fetchCompletedCashoutCount(client, playerUid),
      fetchLatestCompletedRechargeAmount(client, playerUid),
    ]);
    const remainingQuota = Math.max(0, PLAYER_CASHOUT_MAX_NPR_PER_24_H - rollingUsed);

    const playerLock = await client.query(
      `
        SELECT uid, username, role, status, cash, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerLock.rows.length) throw new Error('Player profile not found.');
    const player = playerLock.rows[0] as Record<string, unknown>;
    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error('Only players can create cashout tasks.');
    }

    const availableCash = Math.max(0, Math.floor(Number(player.cash || 0)));
    if (availableCash <= 0) throw new Error('No cash available to cash out.');

    const amountThisRequest = Math.min(availableCash, remainingQuota);
    if (amountThisRequest <= 0) {
      throw new Error(
        `Rolling 24-hour cash out limit (${PLAYER_CASHOUT_MAX_NPR_PER_24_H} NPR) is reached for now.`
      );
    }

    const decision = evaluateWithdrawalPolicy({
      amountNpr: amountThisRequest,
      completedWithdrawalCount: completedCashoutCount,
      lastRechargeAmountNpr,
    });
    if (!decision.allowed) throw new Error(decision.message);

    const coadminUid = cleanText(player.coadmin_uid) || cleanText(player.created_by);
    if (!coadminUid) throw new Error('Player coadmin scope not found.');

    const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid);
    if (maintenanceBreak.enabled) {
      console.info('[MAINTENANCE] blocked redeem request', { playerUid, coadminUid });
      throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
    }

    const newCash = availableCash - amountThisRequest;
    await updateBalances(client, playerUid, { cash: newCash });

    const playerUsername =
      cleanText(input.playerUsername) || cleanText(player.username) || 'Player';
    const taskRaw = {
      coadminUid,
      playerUid,
      playerUsername,
      amountNpr: amountThisRequest,
      paymentDetails,
      payoutMethod: cleanText(input.payoutMethod) || null,
      qrImageUrl: cleanText(input.qrImageUrl) || null,
      paymentAppName: cleanText(input.paymentAppName) || null,
      paymentAppCashTag: cleanText(input.paymentAppCashTag) || null,
      paymentAppAccountName: cleanText(input.paymentAppAccountName) || null,
      cashDeductedOnRequest: true,
      status: 'pending',
      assignedHandlerUid: null,
      assignedHandlerUsername: null,
      startedAt: null,
      expiresAt: null,
      createdAt: nowIso,
      completedAt: null,
    };

    await upsertCashoutTaskCache(client, taskId, {
      ...taskRaw,
      source: 'authority_cashout_create',
      rawFirestoreData: taskRaw,
    });

    const rawEvent = {
      playerUid,
      coadminUid,
      amountNpr: amountThisRequest,
      type: 'cashout_request_deduct',
      cashoutTaskId: taskId,
      createdAt: nowIso,
      ttlExpiresAt: ttlAfterDays(90),
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, player_uid, coadmin_uid, type, amount_npr, cashout_task_id,
          before_cash, after_cash, created_at, updated_at, ttl_expires_at,
          source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1, $2, $3, 'cashout_request_deduct', $4, $5,
          $6, $7, $8::timestamptz, $8::timestamptz, $9::timestamptz,
          'authority_cashout_create', now(), NULL, $10::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        eventId,
        playerUid,
        coadminUid,
        amountThisRequest,
        taskId,
        availableCash,
        newCash,
        nowIso,
        ttlAfterDays(90),
        JSON.stringify(rawEvent),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `financialEvents:${eventId}:${playerUid}:cash:cashout_request_cash_debit`,
      userUid: playerUid,
      username: playerUsername,
      role: 'player',
      coadminUid,
      balanceType: 'cash',
      direction: 'debit',
      delta: -amountThisRequest,
      absoluteAfter: newCash,
      eventType: 'cashout_request_cash_debit',
      sourceCollection: 'financialEvents',
      sourceId: eventId,
      actorUid: playerUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: rawEvent,
      sourceFields: { amount: amountThisRequest, cashoutTaskId: taskId },
    });

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid,
      taskId,
      status: 'pending',
      amountNpr: amountThisRequest,
      eventType: 'cashout_create',
      updatedAt: nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ taskId, playerUid, amountNpr: amountThisRequest })]
    );

    await client.query('COMMIT');
    return { success: true, duplicate: false, taskId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completePlayerCashoutTaskInSql(
  input: AuthorityCashoutCompleteInput
): Promise<AuthorityCashoutCompleteResult> {
  const taskId = cleanText(input.taskId);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  if (!taskId) throw new Error('taskId is required.');
  if (!actorUid || !actorRole) throw new Error('Actor is required.');

  const idempotencyKey = cleanText(input.idempotencyKey) || taskId;
  const operationKey = `cashout_complete:${taskId}:${idempotencyKey}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.taskId) {
    return {
      success: true,
      duplicate: true,
      alreadyCompleted: existing.alreadyCompleted === true,
      taskId,
    };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const eventId = randomUUID();
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const taskLock = await client.query(
      `SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [taskId]
    );
    if (!taskLock.rows.length) throw new Error('Cashout task not found.');
    const task = taskLock.rows[0] as Record<string, unknown>;
    const status = cleanText(task.status).toLowerCase();

    if (status === 'completed') {
      await client.query('COMMIT');
      return { success: true, duplicate: true, alreadyCompleted: true, taskId };
    }
    if (status !== 'pending' && status !== 'in_progress') {
      throw new Error('Cashout task is not available to complete.');
    }

    const taskScope = cleanText(task.coadmin_uid);
    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== taskScope)) {
      throw new Error('Forbidden: cashout task is outside your scope.');
    }

    const assignedHandlerUid = cleanText(task.assigned_handler_uid);
    if (
      status === 'in_progress' &&
      assignedHandlerUid &&
      assignedHandlerUid !== actorUid &&
      !input.isAdmin &&
      actorRole !== 'coadmin'
    ) {
      throw new Error('This task is already assigned to another handler.');
    }

    const requestedAmount = Math.max(0, Math.round(Number(task.amount_npr || 0)));
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw new Error('Cashout task amount is invalid.');
    }

    const shouldDeductOnComplete = task.cash_deducted_on_request !== true;
    const playerUid = cleanText(task.player_uid);
    let playerCash = 0;
    if (shouldDeductOnComplete) {
      const playerLock = await client.query(
        `SELECT cash FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL FOR UPDATE`,
        [playerUid]
      );
      if (!playerLock.rows.length) throw new Error('Cashout task player not found.');
      playerCash = Math.max(0, Math.floor(Number((playerLock.rows[0] as Record<string, unknown>).cash || 0)));
      if (playerCash < requestedAmount) {
        throw new Error('Cashout task player cash is lower than the requested amount.');
      }
    }

    const handlerLock = await client.query(
      `SELECT * FROM public.user_balance_snapshots_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [actorUid]
    );
    const handlerSnapshot = (handlerLock.rows[0] as Record<string, unknown> | undefined) || {};
    const handlerPlayer = await client.query(
      `SELECT raw_firestore_data FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL`,
      [actorUid]
    );
    const handlerPlayerRow = (handlerPlayer.rows[0] as Record<string, unknown> | undefined) || {};

    const rewardNpr = Math.max(1, Math.round(requestedAmount * 0.05));
    const rewardBlocked = readRewardBlocked(handlerSnapshot, handlerPlayerRow);
    const rewardAppliedNpr = rewardBlocked ? 0 : rewardNpr;
    const handlerCreditAmount = requestedAmount + rewardAppliedNpr;
    const cashBoxBefore = readCashBoxNpr(handlerSnapshot, handlerPlayerRow);
    const cashBoxAfter = cashBoxBefore + handlerCreditAmount;
    const cashBoxDelta = cashBoxAfter - cashBoxBefore;

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_complete',
      userUid: playerUid,
      sourceId: taskId,
      actorUid,
      actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      return {
        success: true,
        duplicate: true,
        alreadyCompleted: payload?.alreadyCompleted === true,
        taskId,
      };
    }

    const taskRaw = {
      ...(task.raw_firestore_data && typeof task.raw_firestore_data === 'object' && !Array.isArray(task.raw_firestore_data)
        ? (task.raw_firestore_data as Record<string, unknown>)
        : {}),
      status: 'completed',
      assignedHandlerUid: actorUid,
      assignedHandlerUsername: cleanText(input.actorUsername) || 'Handler',
      cashoutRequestedByStaffId: actorRole === 'staff' ? actorUid : null,
      rewardNprApplied: rewardAppliedNpr,
      rewardBlockedApplied: rewardBlocked,
      payoutAmountNpr: requestedAmount,
      rewardAmountNpr: rewardAppliedNpr,
      cashBoxBefore,
      cashBoxAfter,
      cashBoxDelta,
      actorUid,
      actorRole,
      sourceCashoutId: taskId,
      startedAt: toIsoString(task.started_at) || nowIso,
      expiresAt: null,
      completedAt: nowIso,
    };

    await upsertCashoutTaskCache(client, taskId, {
      coadminUid: taskScope,
      playerUid,
      playerUsername: cleanText(task.player_username),
      amountNpr: requestedAmount,
      paymentDetails: cleanText(task.payment_details),
      payoutMethod: cleanText(task.payout_method),
      qrImageUrl: cleanText(task.qr_image_url),
      paymentAppName: cleanText(task.payment_app_name),
      paymentAppCashTag: cleanText(task.payment_app_cash_tag),
      paymentAppAccountName: cleanText(task.payment_app_account_name),
      cashDeductedOnRequest: task.cash_deducted_on_request === true,
      status: 'completed',
      assignedHandlerUid: actorUid,
      assignedHandlerUsername: cleanText(input.actorUsername) || 'Handler',
      cashoutRequestedByStaffId: actorRole === 'staff' ? actorUid : null,
      rewardNprApplied: rewardAppliedNpr,
      rewardBlockedApplied: rewardBlocked,
      startedAt: task.started_at,
      expiresAt: null,
      createdAt: task.created_at,
      completedAt: nowIso,
      source: 'authority_cashout_complete',
      rawFirestoreData: taskRaw,
    });

    if (shouldDeductOnComplete) {
      await updateBalances(client, playerUid, { cash: playerCash - requestedAmount });
    }
    await updateBalances(client, actorUid, { cashBoxNpr: cashBoxAfter });

    const rawEvent = {
      playerUid,
      coadminUid: taskScope,
      amountNpr: requestedAmount,
      type: 'cashout',
      cashoutTaskId: taskId,
      createdAt: nowIso,
      cashBoxBefore,
      cashBoxAfter,
      cashBoxDelta,
      actorUid,
      actorRole,
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, player_uid, coadmin_uid, type, amount_npr, cashout_task_id,
          created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1, $2, $3, 'cashout', $4, $5,
          $6::timestamptz, $6::timestamptz, 'authority_cashout_complete', now(), NULL, $7::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [eventId, playerUid, taskScope, requestedAmount, taskId, nowIso, JSON.stringify(rawEvent)]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `playerCashoutTasks:${taskId}:${actorUid}:cashBoxNpr:cashout_handler_cashbox_credit`,
      userUid: actorUid,
      role: actorRole,
      coadminUid: taskScope,
      balanceType: 'cashBoxNpr',
      direction: 'credit',
      delta: cashBoxDelta,
      absoluteAfter: cashBoxAfter,
      eventType: 'cashout_handler_cashbox_credit',
      sourceCollection: 'player_cashout_tasks_cache',
      sourceId: taskId,
      actorUid,
      actorRole,
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: taskRaw,
      sourceFields: {
        cashBoxBefore,
        cashBoxAfter,
        cashBoxDelta,
        payoutAmountNpr: requestedAmount,
        rewardAmountNpr: rewardAppliedNpr,
      },
    });

    if (shouldDeductOnComplete) {
      await insertAuthorityLedgerEvent(client, {
        eventKey: `playerCashoutTasks:${taskId}:${playerUid}:cash:cashout_complete_cash_debit_legacy`,
        userUid: playerUid,
        role: 'player',
        coadminUid: taskScope,
        balanceType: 'cash',
        direction: 'debit',
        delta: -requestedAmount,
        absoluteAfter: playerCash - requestedAmount,
        eventType: 'cashout_complete_cash_debit_legacy',
        sourceCollection: 'player_cashout_tasks_cache',
        sourceId: taskId,
        actorUid,
        actorRole,
        confidence: 'high',
        sourceCreatedAt: nowIso,
        rawSourceData: taskRaw,
        sourceFields: { amount: requestedAmount },
      });
    }

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid: taskScope,
      taskId,
      status: 'completed',
      amountNpr: requestedAmount,
      eventType: 'cashout_complete',
      updatedAt: nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ taskId, alreadyCompleted: false })]
    );

    await client.query('COMMIT');
    return { success: true, duplicate: false, alreadyCompleted: false, taskId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function startPlayerCashoutTaskInSql(
  input: AuthorityCashoutStartInput
): Promise<AuthorityCashoutStartResult> {
  const taskId = cleanText(input.taskId);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  if (!taskId) throw new Error('taskId is required.');
  if (!actorUid || !actorRole) throw new Error('Actor is required.');

  const operationKey = `cashout_start:${taskId}:${actorUid}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.taskId && existing.expiresAtMs != null) {
    return {
      success: true,
      duplicate: true,
      taskId,
      expiresAtMs: Number(existing.expiresAtMs),
    };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + CASHOUT_TASK_DURATION_MS).toISOString();
  const expiresAtMs = Date.parse(expiresAtIso);
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const taskLock = await client.query(
      `SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [taskId]
    );
    if (!taskLock.rows.length) throw new Error('Cashout task not found.');
    const task = taskLock.rows[0] as Record<string, unknown>;
    const status = cleanText(task.status).toLowerCase();
    const taskScope = cleanText(task.coadmin_uid);
    const playerUid = cleanText(task.player_uid);
    const amountNpr = Math.max(0, Math.round(Number(task.amount_npr || 0)));

    if (!input.isAdmin && (!input.scopeUid || input.scopeUid !== taskScope)) {
      throw new Error('Forbidden: cashout task is outside your scope.');
    }
    if (status === 'completed') {
      throw new Error('Task already completed.');
    }
    if (status === 'declined') {
      throw new Error('Task already declined.');
    }
    if (status !== 'pending' && status !== 'in_progress') {
      throw new Error('Cashout task is not available to start.');
    }

    const assignedHandlerUid = cleanText(task.assigned_handler_uid);
    const expiresAtMsExisting = task.expires_at ? Date.parse(String(task.expires_at)) : 0;
    const activeInProgress =
      status === 'in_progress' && (!expiresAtMsExisting || expiresAtMsExisting > Date.now());
    if (activeInProgress && assignedHandlerUid && assignedHandlerUid !== actorUid) {
      throw new Error('This task is already assigned to another handler.');
    }

    if (
      activeInProgress &&
      assignedHandlerUid === actorUid &&
      expiresAtMsExisting > Date.now()
    ) {
      const claim = await claimAuthorityOperation(client, {
        operationKey,
        operationType: 'cashout_start',
        userUid: playerUid,
        sourceId: taskId,
        actorUid,
        actorRole,
        payload: { taskId, expiresAtMs: expiresAtMsExisting },
      });
      await client.query('COMMIT');
      return {
        success: true,
        duplicate: claim.duplicate,
        taskId,
        expiresAtMs: expiresAtMsExisting,
      };
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_start',
      userUid: playerUid,
      sourceId: taskId,
      actorUid,
      actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      const payload = await readAuthorityOperationPayload(operationKey);
      await client.query('COMMIT');
      return {
        success: true,
        duplicate: true,
        taskId,
        expiresAtMs: Number(payload?.expiresAtMs || expiresAtMs),
      };
    }

    const taskRaw = {
      ...(task.raw_firestore_data &&
      typeof task.raw_firestore_data === 'object' &&
      !Array.isArray(task.raw_firestore_data)
        ? (task.raw_firestore_data as Record<string, unknown>)
        : {}),
      status: 'in_progress',
      assignedHandlerUid: actorUid,
      assignedHandlerUsername: cleanText(input.actorUsername) || 'Handler',
      startedAt: nowIso,
      expiresAt: expiresAtIso,
      updatedAt: nowIso,
    };

    await upsertCashoutTaskCache(client, taskId, {
      coadminUid: taskScope,
      playerUid,
      playerUsername: cleanText(task.player_username),
      amountNpr,
      paymentDetails: cleanText(task.payment_details),
      payoutMethod: cleanText(task.payout_method),
      qrImageUrl: cleanText(task.qr_image_url),
      paymentAppName: cleanText(task.payment_app_name),
      paymentAppCashTag: cleanText(task.payment_app_cash_tag),
      paymentAppAccountName: cleanText(task.payment_app_account_name),
      cashDeductedOnRequest: task.cash_deducted_on_request === true,
      status: 'in_progress',
      assignedHandlerUid: actorUid,
      assignedHandlerUsername: cleanText(input.actorUsername) || 'Handler',
      startedAt: nowIso,
      expiresAt: expiresAtIso,
      createdAt: task.created_at,
      source: 'authority_cashout_start',
      rawFirestoreData: taskRaw,
    });

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid: taskScope,
      taskId,
      status: 'in_progress',
      amountNpr,
      eventType: 'cashout_start',
      updatedAt: nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ taskId, expiresAtMs })]
    );

    await client.query('COMMIT');
    return { success: true, duplicate: false, taskId, expiresAtMs };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function declinePlayerCashoutTaskInSql(
  input: AuthorityCashoutDeclineInput
): Promise<AuthorityCashoutDeclineResult> {
  const taskId = cleanText(input.taskId);
  if (!taskId) throw new Error('taskId is required.');

  const idempotencyKey = cleanText(input.idempotencyKey) || taskId;
  const operationKey = `cashout_decline:${taskId}:${idempotencyKey}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.taskId) {
    return {
      success: true,
      duplicate: true,
      taskId,
      refunded: existing.refunded === true,
    };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const eventId = randomUUID();
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const taskLock = await client.query(
      `SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [taskId]
    );
    if (!taskLock.rows.length) throw new Error('Cashout task not found.');
    const task = taskLock.rows[0] as Record<string, unknown>;
    const status = cleanText(task.status).toLowerCase();

    if (status === 'declined') {
      await client.query('COMMIT');
      return {
        success: true,
        duplicate: true,
        taskId,
        refunded: task.cash_deducted_on_request === true,
      };
    }
    if (status !== 'pending' && status !== 'in_progress') {
      throw new Error('Only active cashout tasks can be declined.');
    }

    const taskScope = cleanText(task.coadmin_uid);
    if (!input.isAdmin && taskScope !== cleanText(input.scopeUid)) {
      throw new Error('Forbidden: cashout task is outside your scope.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'cashout_decline',
      userUid: cleanText(task.player_uid),
      sourceId: taskId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      return {
        success: true,
        duplicate: true,
        taskId,
        refunded: payload?.refunded === true,
      };
    }

    const amountNpr = Math.max(0, Math.round(Number(task.amount_npr || 0)));
    const playerUid = cleanText(task.player_uid);
    let refunded = false;

    const playerLock = await client.query(
      `SELECT cash, username FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL FOR UPDATE`,
      [playerUid]
    );
    const playerCash = playerLock.rows.length
      ? Math.max(0, Math.floor(Number((playerLock.rows[0] as Record<string, unknown>).cash || 0)))
      : 0;
    const playerUsername = playerLock.rows.length
      ? cleanText((playerLock.rows[0] as Record<string, unknown>).username)
      : null;

    const taskRaw = {
      ...(task.raw_firestore_data && typeof task.raw_firestore_data === 'object' && !Array.isArray(task.raw_firestore_data)
        ? (task.raw_firestore_data as Record<string, unknown>)
        : {}),
      status: 'declined',
      expiresAt: null,
      completedAt: nowIso,
    };

    await upsertCashoutTaskCache(client, taskId, {
      coadminUid: taskScope,
      playerUid,
      playerUsername: cleanText(task.player_username),
      amountNpr,
      paymentDetails: cleanText(task.payment_details),
      payoutMethod: cleanText(task.payout_method),
      qrImageUrl: cleanText(task.qr_image_url),
      paymentAppName: cleanText(task.payment_app_name),
      paymentAppCashTag: cleanText(task.payment_app_cash_tag),
      paymentAppAccountName: cleanText(task.payment_app_account_name),
      cashDeductedOnRequest: task.cash_deducted_on_request === true,
      status: 'declined',
      assignedHandlerUid: cleanText(task.assigned_handler_uid),
      assignedHandlerUsername: cleanText(task.assigned_handler_username),
      startedAt: task.started_at,
      expiresAt: null,
      createdAt: task.created_at,
      completedAt: nowIso,
      source: 'authority_cashout_decline',
      rawFirestoreData: taskRaw,
    });

    if (task.cash_deducted_on_request === true && amountNpr > 0) {
      const newCash = playerCash + amountNpr;
      await updateBalances(client, playerUid, { cash: newCash });
      refunded = true;

      const rawEvent = {
        playerUid,
        coadminUid: taskScope,
        amountNpr,
        type: 'cashout_decline_refund',
        cashoutTaskId: taskId,
        createdAt: nowIso,
      };

      await client.query(
        `
          INSERT INTO public.financial_events_cache (
            firebase_id, player_uid, coadmin_uid, type, amount_npr, cashout_task_id,
            before_cash, after_cash, created_at, updated_at, source, mirrored_at, deleted_at,
            raw_firestore_data
          )
          VALUES (
            $1, $2, $3, 'cashout_decline_refund', $4, $5,
            $6, $7, $8::timestamptz, $8::timestamptz, 'authority_cashout_decline', now(), NULL,
            $9::jsonb
          )
          ON CONFLICT (firebase_id) DO NOTHING
        `,
        [
          eventId,
          playerUid,
          taskScope,
          amountNpr,
          taskId,
          playerCash,
          newCash,
          nowIso,
          JSON.stringify(rawEvent),
        ]
      );

      await insertAuthorityLedgerEvent(client, {
        eventKey: `financialEvents:${eventId}:${playerUid}:cash:cashout_decline_cash_refund`,
        userUid: playerUid,
        username: playerUsername,
        role: 'player',
        coadminUid: taskScope,
        balanceType: 'cash',
        direction: 'credit',
        delta: amountNpr,
        absoluteAfter: newCash,
        eventType: 'cashout_decline_cash_refund',
        sourceCollection: 'financialEvents',
        sourceId: eventId,
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        confidence: 'high',
        sourceCreatedAt: nowIso,
        rawSourceData: rawEvent,
        sourceFields: { amount: amountNpr, cashoutTaskId: taskId },
      });
    }

    await writeCashoutOutbox(client, {
      playerUid,
      coadminUid: taskScope,
      taskId,
      status: 'declined',
      amountNpr,
      eventType: 'cashout_decline',
      updatedAt: nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ taskId, refunded })]
    );

    await client.query('COMMIT');
    return { success: true, duplicate: false, taskId, refunded };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
