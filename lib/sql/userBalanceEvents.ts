import 'server-only';

import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  numberOrNull,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

type BalanceType = 'coin' | 'cash' | 'cashBoxNpr' | 'promoLockedCoins' | 'referralBonusCoins';
type Direction = 'credit' | 'debit' | 'set' | 'baseline' | 'residual';
type Confidence = 'high' | 'medium' | 'low' | 'baseline' | 'residual';

export type UserBalanceEventInput = {
  eventKey: string;
  userUid: string;
  username?: unknown;
  role?: unknown;
  coadminUid?: unknown;
  balanceType: BalanceType;
  direction: Direction;
  delta?: unknown;
  absoluteAfter?: unknown;
  eventType: string;
  reasonType?: unknown;
  sourceCollection: string;
  sourceId: string;
  sourceType?: unknown;
  relatedPlayerUid?: unknown;
  relatedRequestId?: unknown;
  relatedTaskId?: unknown;
  relatedCashoutTaskId?: unknown;
  relatedTransferRequestId?: unknown;
  relatedRewardId?: unknown;
  relatedClaimId?: unknown;
  relatedJobId?: unknown;
  actorUid?: unknown;
  actorRole?: unknown;
  confidence: Confidence;
  confidenceReason?: unknown;
  sourceCreatedAt?: unknown;
  isBaseline?: boolean;
  isResidualAdjustment?: boolean;
  createdByBackfill?: boolean;
  rawSourceData?: unknown;
  sourceFields?: unknown;
};

type BuildOptions = {
  includeBaseline?: boolean;
  includeDerived?: boolean;
  includeLowConfidence?: boolean;
};

type RebuildOptions = BuildOptions & {
  clearExisting?: boolean;
};

function jsonObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return normalizeJson(value) || {};
}

function num(value: unknown) {
  return numberOrNull(value);
}

function raw(row: Record<string, unknown>) {
  return (row.raw_firestore_data || {}) as Record<string, unknown>;
}

function sourceDate(...values: unknown[]) {
  for (const value of values) {
    const iso = toIsoString(value);
    if (iso) return iso;
  }
  return null;
}

function profileFor(
  profiles: Map<string, Record<string, unknown>>,
  userUid: string,
  fallback?: Record<string, unknown>
) {
  const found = profiles.get(userUid);
  return {
    username: found?.username || fallback?.username,
    role: found?.role || fallback?.role,
    coadminUid: found?.coadmin_uid || found?.coadminUid || fallback?.coadmin_uid || fallback?.coadminUid,
  };
}

function makeEvent(
  input: Omit<UserBalanceEventInput, 'direction'> & { direction?: Direction },
  profiles: Map<string, Record<string, unknown>>,
  fallbackProfile?: Record<string, unknown>
): UserBalanceEventInput | null {
  const userUid = cleanText(input.userUid);
  const eventKey = cleanText(input.eventKey);
  const sourceId = cleanText(input.sourceId);
  if (!userUid || !eventKey || !sourceId) return null;
  const delta = num(input.delta);
  const absoluteAfter = num(input.absoluteAfter);
  const direction =
    input.direction ||
    (delta == null ? 'set' : delta < 0 ? 'debit' : delta > 0 ? 'credit' : 'set');
  const profile = profileFor(profiles, userUid, fallbackProfile);
  return {
    ...input,
    eventKey,
    userUid,
    username: input.username ?? profile.username,
    role: input.role ?? profile.role,
    coadminUid: input.coadminUid ?? profile.coadminUid,
    direction,
    delta,
    absoluteAfter,
    sourceId,
  };
}

function add(events: UserBalanceEventInput[], event: UserBalanceEventInput | null) {
  if (event) events.push(event);
}

export async function upsertUserBalanceEvent(input: UserBalanceEventInput) {
  const db = getPlayerMirrorPool();
  const eventKey = cleanText(input.eventKey);
  const userUid = cleanText(input.userUid);
  if (!db || !eventKey || !userUid) return false;

  try {
    await db.query(
      `
        INSERT INTO public.user_balance_events (
          event_key, user_uid, username, role, coadmin_uid, balance_type, direction,
          delta, absolute_after, event_type, reason_type, source_collection, source_id,
          source_type, related_player_uid, related_request_id, related_task_id,
          related_cashout_task_id, related_transfer_request_id, related_reward_id,
          related_claim_id, related_job_id, actor_uid, actor_role, confidence,
          confidence_reason, source_created_at, derived_at, is_baseline,
          is_residual_adjustment, created_by_backfill, raw_source_data, source_fields,
          deleted_at
        )
        VALUES (
          $1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, $7,
          $8, $9, $10, NULLIF($11, ''), $12, $13, NULLIF($14, ''),
          NULLIF($15, ''), NULLIF($16, ''), NULLIF($17, ''), NULLIF($18, ''),
          NULLIF($19, ''), NULLIF($20, ''), NULLIF($21, ''), NULLIF($22, ''),
          NULLIF($23, ''), NULLIF($24, ''), $25, NULLIF($26, ''),
          $27::timestamptz, now(), $28, $29, $30, $31::jsonb, $32::jsonb, NULL
        )
        ON CONFLICT (event_key) DO UPDATE SET
          user_uid = EXCLUDED.user_uid,
          username = EXCLUDED.username,
          role = EXCLUDED.role,
          coadmin_uid = EXCLUDED.coadmin_uid,
          balance_type = EXCLUDED.balance_type,
          direction = EXCLUDED.direction,
          delta = EXCLUDED.delta,
          absolute_after = EXCLUDED.absolute_after,
          event_type = EXCLUDED.event_type,
          reason_type = EXCLUDED.reason_type,
          source_collection = EXCLUDED.source_collection,
          source_id = EXCLUDED.source_id,
          source_type = EXCLUDED.source_type,
          related_player_uid = EXCLUDED.related_player_uid,
          related_request_id = EXCLUDED.related_request_id,
          related_task_id = EXCLUDED.related_task_id,
          related_cashout_task_id = EXCLUDED.related_cashout_task_id,
          related_transfer_request_id = EXCLUDED.related_transfer_request_id,
          related_reward_id = EXCLUDED.related_reward_id,
          related_claim_id = EXCLUDED.related_claim_id,
          related_job_id = EXCLUDED.related_job_id,
          actor_uid = EXCLUDED.actor_uid,
          actor_role = EXCLUDED.actor_role,
          confidence = EXCLUDED.confidence,
          confidence_reason = EXCLUDED.confidence_reason,
          source_created_at = EXCLUDED.source_created_at,
          derived_at = now(),
          is_baseline = EXCLUDED.is_baseline,
          is_residual_adjustment = EXCLUDED.is_residual_adjustment,
          created_by_backfill = EXCLUDED.created_by_backfill,
          raw_source_data = EXCLUDED.raw_source_data,
          source_fields = EXCLUDED.source_fields,
          deleted_at = NULL
      `,
      [
        eventKey,
        userUid,
        cleanText(input.username),
        cleanText(input.role),
        cleanText(input.coadminUid),
        input.balanceType,
        input.direction,
        numberOrNull(input.delta),
        numberOrNull(input.absoluteAfter),
        cleanText(input.eventType),
        cleanText(input.reasonType),
        cleanText(input.sourceCollection),
        cleanText(input.sourceId),
        cleanText(input.sourceType),
        cleanText(input.relatedPlayerUid),
        cleanText(input.relatedRequestId),
        cleanText(input.relatedTaskId),
        cleanText(input.relatedCashoutTaskId),
        cleanText(input.relatedTransferRequestId),
        cleanText(input.relatedRewardId),
        cleanText(input.relatedClaimId),
        cleanText(input.relatedJobId),
        cleanText(input.actorUid),
        cleanText(input.actorRole),
        input.confidence,
        cleanText(input.confidenceReason),
        toIsoString(input.sourceCreatedAt),
        Boolean(input.isBaseline),
        Boolean(input.isResidualAdjustment),
        Boolean(input.createdByBackfill),
        JSON.stringify(jsonObject(input.rawSourceData)),
        JSON.stringify(jsonObject(input.sourceFields)),
      ]
    );
    return true;
  } catch (error) {
    console.error('[USER_BALANCE_EVENTS] upsert failed', { eventKey, error });
    return false;
  }
}

export async function tombstoneUserBalanceEvent(eventKey: string) {
  const db = getPlayerMirrorPool();
  const cleanKey = cleanText(eventKey);
  if (!db || !cleanKey) return false;
  try {
    await db.query(
      'UPDATE public.user_balance_events SET deleted_at = now(), derived_at = now() WHERE event_key = $1',
      [cleanKey]
    );
    return true;
  } catch (error) {
    console.error('[USER_BALANCE_EVENTS] tombstone failed', { eventKey: cleanKey, error });
    return false;
  }
}

export async function getUserBalanceEventByKey(eventKey: string) {
  const db = getPlayerMirrorPool();
  const cleanKey = cleanText(eventKey);
  if (!db || !cleanKey) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.user_balance_events WHERE event_key = $1 LIMIT 1',
      [cleanKey]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[USER_BALANCE_EVENTS] get failed', { eventKey: cleanKey, error });
    return null;
  }
}

async function loadRows(table: string) {
  const db = getPlayerMirrorPool();
  if (!db) return [];
  const result = await db.query(`SELECT * FROM public.${table} WHERE deleted_at IS NULL`);
  return result.rows as Record<string, unknown>[];
}

export async function buildUserBalanceEventsFromMirrors(options: BuildOptions = {}) {
  const includeBaseline = options.includeBaseline !== false;
  const includeDerived = options.includeDerived !== false;
  const includeLowConfidence = Boolean(options.includeLowConfidence);
  const events: UserBalanceEventInput[] = [];
  const profiles = new Map<string, Record<string, unknown>>();
  const snapshots = await loadRows('user_balance_snapshots_cache');

  for (const row of snapshots) {
    profiles.set(cleanText(row.firebase_id), row);
  }

  if (includeBaseline) {
    for (const row of snapshots) {
      const userUid = cleanText(row.firebase_id);
      for (const [column, balanceType] of [
        ['coin', 'coin'],
        ['cash', 'cash'],
        ['cash_box_npr', 'cashBoxNpr'],
        ['promo_locked_coins', 'promoLockedCoins'],
        ['referral_bonus_coins', 'referralBonusCoins'],
      ] as const) {
        const value = num(row[column]);
        if (value == null) continue;
        add(events, makeEvent({
          eventKey: `baseline:${userUid}:${balanceType}`,
          userUid,
          balanceType,
          direction: 'baseline',
          delta: 0,
          absoluteAfter: value,
          eventType: 'baseline_snapshot',
          sourceCollection: 'user_balance_snapshots_cache',
          sourceId: userUid,
          confidence: 'baseline',
          confidenceReason: 'Latest mirrored user balance snapshot.',
          sourceCreatedAt: row.updated_at || row.created_at || row.mirrored_at,
          isBaseline: true,
          rawSourceData: raw(row),
          sourceFields: { value },
        }, profiles, row));
      }
    }
  }

  if (!includeDerived) return events;

  const financialRows = await loadRows('financial_events_cache');
  const financialRequestKeys = new Set<string>();
  const financialCashoutTaskKeys = new Set<string>();
  const financialTransferRequestIds = new Set<string>();

  for (const row of financialRows) {
    const type = cleanText(row.type);
    const requestId = cleanText(row.request_id);
    const cashoutTaskId = cleanText(row.cashout_task_id);
    const transferRequestId = cleanText(row.transfer_request_id);
    if (requestId) financialRequestKeys.add(`${requestId}:${type}`);
    if (cashoutTaskId) financialCashoutTaskKeys.add(`${cashoutTaskId}:${type}`);
    if (transferRequestId) financialTransferRequestIds.add(transferRequestId);
  }

  for (const row of financialRows) {
    const id = cleanText(row.firebase_id);
    const type = cleanText(row.type);
    const userUid = cleanText(row.player_uid || row.player_id);
    const amount = num(row.amount_npr ?? row.amount ?? row.amount_coins) || 0;
    const rowRaw = raw(row);
    const common = {
      userUid,
      sourceCollection: 'financial_events_cache',
      sourceId: id,
      sourceType: type,
      relatedRequestId: row.request_id,
      relatedCashoutTaskId: row.cashout_task_id,
      relatedTransferRequestId: row.transfer_request_id,
      relatedTaskId: row.task_id,
      relatedJobId: row.automation_job_id,
      actorUid: row.actor_uid,
      actorRole: row.actor_role,
      sourceCreatedAt: row.created_at,
      rawSourceData: rowRaw,
    };
    if (type === 'recharge_request_deduct') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:coin:recharge_request_coin_debit`, balanceType: 'coin', delta: -amount, eventType: 'recharge_request_coin_debit', confidence: 'medium', confidenceReason: 'Financial event amount records recharge coin debit.', sourceFields: { amount } }, profiles));
    } else if (type === 'recharge_refund') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:coin:recharge_refund_coin_credit`, balanceType: 'coin', delta: amount, eventType: 'recharge_refund_coin_credit', confidence: 'medium', sourceFields: { amount } }, profiles));
    } else if (type === 'redeem') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:cash:redeem_cash_credit`, balanceType: 'cash', delta: amount, eventType: 'redeem_cash_credit', confidence: 'medium', sourceFields: { amount } }, profiles));
    } else if (type === 'cashout_request_deduct') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:cash:cashout_request_cash_debit`, balanceType: 'cash', delta: -amount, eventType: 'cashout_request_cash_debit', confidence: 'medium', sourceFields: { amount } }, profiles));
    } else if (type === 'cashout_decline_refund') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:cash:cashout_decline_cash_refund`, balanceType: 'cash', delta: amount, eventType: 'cashout_decline_cash_refund', confidence: 'medium', sourceFields: { amount } }, profiles));
    } else if (type === 'cash_to_coin_transfer') {
      const cashDelta = (num(row.after_cash) ?? 0) - (num(row.before_cash) ?? 0);
      const coinDelta = (num(row.after_coin) ?? 0) - (num(row.before_coin) ?? 0);
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:cash:cash_to_coin_cash_debit`, balanceType: 'cash', delta: cashDelta, absoluteAfter: row.after_cash, eventType: 'cash_to_coin_cash_debit', confidence: 'high', sourceFields: { beforeCash: row.before_cash, afterCash: row.after_cash } }, profiles));
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:coin:cash_to_coin_coin_credit`, balanceType: 'coin', delta: coinDelta, absoluteAfter: row.after_coin, eventType: 'cash_to_coin_coin_credit', confidence: 'high', sourceFields: { beforeCoin: row.before_coin, afterCoin: row.after_coin } }, profiles));
    } else if (type === 'coin_to_cash_transfer') {
      const cashDelta = (num(row.after_cash) ?? 0) - (num(row.before_cash) ?? 0);
      const coinDelta = (num(row.after_coin) ?? 0) - (num(row.before_coin) ?? 0);
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:coin:coin_to_cash_coin_debit`, balanceType: 'coin', delta: coinDelta, absoluteAfter: row.after_coin, eventType: 'coin_to_cash_coin_debit', confidence: 'high', sourceFields: { beforeCoin: row.before_coin, afterCoin: row.after_coin } }, profiles));
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:cash:coin_to_cash_cash_credit`, balanceType: 'cash', delta: cashDelta, absoluteAfter: row.after_cash, eventType: 'coin_to_cash_cash_credit', confidence: 'high', sourceFields: { beforeCash: row.before_cash, afterCash: row.after_cash } }, profiles));
    } else if (type === 'transfer') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:cash:legacy_transfer_cash_debit`, balanceType: 'cash', delta: -amount, eventType: 'legacy_transfer_cash_debit', confidence: 'medium', sourceFields: { amount } }, profiles));
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:coin:legacy_transfer_coin_credit`, balanceType: 'coin', delta: amount, eventType: 'legacy_transfer_coin_credit', confidence: 'medium', sourceFields: { amount } }, profiles));
    } else if (type === 'freeplay') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:coin:freeplay_coin_credit`, balanceType: 'coin', delta: amount, eventType: 'freeplay_coin_credit', confidence: 'medium', relatedRewardId: row.gift_id, sourceFields: { amount } }, profiles));
    } else if (type === 'coadmin_coin_add' || type === 'coadmin_coin_deduct') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:coin:manual_coin_adjust`, balanceType: 'coin', delta: type.endsWith('_deduct') ? -amount : amount, eventType: 'manual_coin_adjust', confidence: 'medium', sourceFields: { amount, type } }, profiles));
    } else if (type === 'coadmin_cash_add' || type === 'coadmin_cash_deduct') {
      add(events, makeEvent({ ...common, eventKey: `financialEvents:${id}:${userUid}:cash:manual_cash_adjust`, balanceType: 'cash', delta: type.endsWith('_deduct') ? -amount : amount, eventType: 'manual_cash_adjust', confidence: 'medium', sourceFields: { amount, type } }, profiles));
    }
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const cashBoxUser = cleanText(rowRaw.staffUid || rowRaw.workerUid || rowRaw.carerUid || rowRaw.relatedUserUid);
    if (cashBoxDelta != null && cashBoxUser) {
      add(events, makeEvent({ ...common, userUid: cashBoxUser, eventKey: `financialEvents:${id}:${cashBoxUser}:cashBoxNpr:bonus_staff_cashbox_credit`, balanceType: 'cashBoxNpr', delta: cashBoxDelta, absoluteAfter: rowRaw.cashBoxAfter, eventType: 'bonus_staff_cashbox_credit', reasonType: rowRaw.rewardReason, confidence: 'high', confidenceReason: 'Source event contains cashBoxDelta audit fields.', sourceFields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta } }, profiles));
    }
  }

  for (const row of await loadRows('player_game_requests_cache')) {
    const id = cleanText(row.firebase_id);
    const type = cleanText(row.type);
    const status = cleanText(row.status);
    const userUid = cleanText(row.player_uid);
    const amount = num(row.base_amount) ?? num(row.amount) ?? 0;
    if (type === 'recharge' && row.coin_deducted_on_request === true && !financialRequestKeys.has(`${id}:recharge_request_deduct`)) {
      add(events, makeEvent({ eventKey: `playerGameRequests:${id}:${userUid}:coin:recharge_request_coin_debit`, userUid, balanceType: 'coin', delta: -amount, eventType: 'recharge_request_coin_debit', sourceCollection: 'player_game_requests_cache', sourceId: id, sourceType: type, relatedRequestId: id, confidence: 'medium', confidenceReason: 'Mirrored request records request-time coin debit and no matching financial event was found.', sourceCreatedAt: row.created_at, rawSourceData: raw(row), sourceFields: { baseAmount: row.base_amount, amount: row.amount, coinDeductedOnRequest: row.coin_deducted_on_request } }, profiles));
    }
    if (type === 'recharge' && status === 'dismissed' && row.coin_refunded_on_dismissal === true && !financialRequestKeys.has(`${id}:recharge_refund`)) {
      add(events, makeEvent({ eventKey: `playerGameRequests:${id}:${userUid}:coin:recharge_refund_coin_credit`, userUid, balanceType: 'coin', delta: amount, eventType: 'recharge_refund_coin_credit', sourceCollection: 'player_game_requests_cache', sourceId: id, sourceType: type, relatedRequestId: id, confidence: 'medium', confidenceReason: 'Mirrored request records dismissal refund and no matching financial event was found.', sourceCreatedAt: row.updated_at || row.created_at, rawSourceData: raw(row), sourceFields: { baseAmount: row.base_amount, amount: row.amount, coinRefundedOnDismissal: row.coin_refunded_on_dismissal } }, profiles));
    }
    if (type === 'redeem' && status === 'completed' && !financialRequestKeys.has(`${id}:redeem`)) {
      add(events, makeEvent({ eventKey: `playerGameRequests:${id}:${userUid}:cash:redeem_cash_credit`, userUid, balanceType: 'cash', delta: amount, eventType: 'redeem_cash_credit', sourceCollection: 'player_game_requests_cache', sourceId: id, sourceType: type, relatedRequestId: id, confidence: 'medium', confidenceReason: 'Mirrored redeem request is completed and no matching financial event was found.', sourceCreatedAt: row.completed_at || row.updated_at || row.created_at, rawSourceData: raw(row), sourceFields: { amount: row.amount } }, profiles));
    }
    if (type === 'recharge' && status !== 'dismissed' && cleanText(row.bonus_event_id)) {
      add(events, makeEvent({ eventKey: `playerGameRequests:${id}:${userUid}:coin:bonus_play_coin_debit`, userUid, balanceType: 'coin', delta: -amount, eventType: 'bonus_play_coin_debit', sourceCollection: 'player_game_requests_cache', sourceId: id, sourceType: cleanText(row.type), relatedRequestId: id, confidence: 'medium', sourceCreatedAt: row.created_at, rawSourceData: raw(row), sourceFields: { baseAmount: row.base_amount, amount: row.amount, bonusEventId: row.bonus_event_id } }, profiles));
    }
  }

  for (const row of await loadRows('player_cashout_tasks_cache')) {
    const id = cleanText(row.firebase_id);
    const status = cleanText(row.status);
    const amount = num(row.amount_npr) || 0;
    const userUid = cleanText(row.player_uid);
    if (row.cash_deducted_on_request === true && !financialCashoutTaskKeys.has(`${id}:cashout_request_deduct`)) {
      add(events, makeEvent({ eventKey: `playerCashoutTasks:${id}:${userUid}:cash:cashout_request_cash_debit`, userUid, balanceType: 'cash', delta: -amount, eventType: 'cashout_request_cash_debit', sourceCollection: 'player_cashout_tasks_cache', sourceId: id, relatedCashoutTaskId: id, confidence: 'medium', confidenceReason: 'Mirrored cashout task records request-time cash debit and no matching financial event was found.', sourceCreatedAt: row.created_at, rawSourceData: raw(row), sourceFields: { amount, cashDeductedOnRequest: row.cash_deducted_on_request } }, profiles));
    }
    if (status === 'declined' && row.cash_deducted_on_request === true && !financialCashoutTaskKeys.has(`${id}:cashout_decline_refund`)) {
      add(events, makeEvent({ eventKey: `playerCashoutTasks:${id}:${userUid}:cash:cashout_decline_cash_refund`, userUid, balanceType: 'cash', delta: amount, eventType: 'cashout_decline_cash_refund', sourceCollection: 'player_cashout_tasks_cache', sourceId: id, relatedCashoutTaskId: id, confidence: 'medium', confidenceReason: 'Mirrored declined cashout task records request-time cash debit and no matching refund financial event was found.', sourceCreatedAt: row.completed_at || row.updated_at || row.created_at, rawSourceData: raw(row), sourceFields: { amount, cashDeductedOnRequest: row.cash_deducted_on_request } }, profiles));
    }
    if (status === 'completed' && row.cash_deducted_on_request === false) {
      add(events, makeEvent({ eventKey: `playerCashoutTasks:${id}:${userUid}:cash:cashout_complete_cash_debit_legacy`, userUid, balanceType: 'cash', delta: -amount, eventType: 'cashout_complete_cash_debit_legacy', sourceCollection: 'player_cashout_tasks_cache', sourceId: id, relatedCashoutTaskId: id, confidence: 'medium', sourceCreatedAt: row.completed_at || row.created_at, rawSourceData: raw(row), sourceFields: { amount } }, profiles));
    }
    const rowRaw = raw(row);
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const handlerUid = cleanText(row.assigned_handler_uid);
    if (status === 'completed' && cashBoxDelta != null && handlerUid) {
      add(events, makeEvent({ eventKey: `playerCashoutTasks:${id}:${handlerUid}:cashBoxNpr:cashout_handler_cashbox_credit`, userUid: handlerUid, balanceType: 'cashBoxNpr', delta: cashBoxDelta, absoluteAfter: rowRaw.cashBoxAfter, eventType: 'cashout_handler_cashbox_credit', sourceCollection: 'player_cashout_tasks_cache', sourceId: id, relatedCashoutTaskId: id, actorUid: rowRaw.actorUid, actorRole: rowRaw.actorRole, confidence: 'high', sourceCreatedAt: row.completed_at || row.created_at, rawSourceData: rowRaw, sourceFields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta, payoutAmountNpr: rowRaw.payoutAmountNpr, rewardAmountNpr: rowRaw.rewardAmountNpr } }, profiles));
    }
  }

  for (const row of await loadRows('player_coin_rewards_cache')) {
    const id = cleanText(row.firebase_id);
    const fromUid = cleanText(row.from_uid);
    const toUid = cleanText(row.to_uid);
    add(events, makeEvent({ eventKey: `playerCoinRewards:${id}:${fromUid}:coin:player_reward_coin_debit`, userUid: fromUid, balanceType: 'coin', delta: -(num(row.amount_coins) || 0), eventType: 'player_reward_coin_debit', sourceCollection: 'player_coin_rewards_cache', sourceId: id, relatedRewardId: id, confidence: 'high', sourceCreatedAt: row.created_at, rawSourceData: raw(row), sourceFields: { amountCoins: row.amount_coins, feeCoins: row.fee_coins } }, profiles));
    add(events, makeEvent({ eventKey: `playerCoinRewards:${id}:${toUid}:coin:player_reward_coin_credit`, userUid: toUid, balanceType: 'coin', delta: num(row.received_coins) || 0, eventType: 'player_reward_coin_credit', sourceCollection: 'player_coin_rewards_cache', sourceId: id, relatedRewardId: id, confidence: 'high', sourceCreatedAt: row.created_at, rawSourceData: raw(row), sourceFields: { receivedCoins: row.received_coins } }, profiles));
  }

  for (const row of await loadRows('referral_reward_claims_cache')) {
    if (cleanText(row.status) !== 'claimed') continue;
    const id = cleanText(row.firebase_id);
    const userUid = cleanText(row.referrer_uid);
    const amount = num(row.reward_amount) || 0;
    add(events, makeEvent({ eventKey: `referralRewardClaims:${id}:${userUid}:coin:referral_reward_coin_credit`, userUid, balanceType: 'coin', delta: amount, eventType: 'referral_reward_coin_credit', sourceCollection: 'referral_reward_claims_cache', sourceId: id, relatedClaimId: id, confidence: 'high', sourceCreatedAt: row.claimed_at || row.qualified_at, rawSourceData: raw(row), sourceFields: { rewardAmount: amount } }, profiles));
    add(events, makeEvent({ eventKey: `referralRewardClaims:${id}:${userUid}:promoLockedCoins:referral_reward_promo_locked_credit`, userUid, balanceType: 'promoLockedCoins', delta: amount, eventType: 'referral_reward_promo_locked_credit', sourceCollection: 'referral_reward_claims_cache', sourceId: id, relatedClaimId: id, confidence: 'high', sourceCreatedAt: row.claimed_at || row.qualified_at, rawSourceData: raw(row), sourceFields: { rewardAmount: amount } }, profiles));
  }

  for (const row of await loadRows('transfer_requests_cache')) {
    const id = cleanText(row.firebase_id);
    if (financialTransferRequestIds.has(id)) continue;
    const status = cleanText(row.status);
    if (status !== 'approved' && status !== 'completed') continue;
    const userUid = cleanText(row.player_uid || row.user_uid);
    const amount = num(row.amount_npr ?? row.amount ?? row.amount_coins) || 0;
    add(events, makeEvent({ eventKey: `transferRequests:${id}:${userUid}:cash:legacy_transfer_cash_debit`, userUid, balanceType: 'cash', delta: -amount, eventType: 'legacy_transfer_cash_debit', sourceCollection: 'transfer_requests_cache', sourceId: id, relatedTransferRequestId: id, confidence: 'medium', confidenceReason: 'Approved mirrored transfer request has no matching financial event.', sourceCreatedAt: row.completed_at || row.updated_at || row.created_at, rawSourceData: raw(row), sourceFields: { amount } }, profiles));
    add(events, makeEvent({ eventKey: `transferRequests:${id}:${userUid}:coin:legacy_transfer_coin_credit`, userUid, balanceType: 'coin', delta: amount, eventType: 'legacy_transfer_coin_credit', sourceCollection: 'transfer_requests_cache', sourceId: id, relatedTransferRequestId: id, confidence: 'medium', confidenceReason: 'Approved mirrored transfer request has no matching financial event.', sourceCreatedAt: row.completed_at || row.updated_at || row.created_at, rawSourceData: raw(row), sourceFields: { amount } }, profiles));
  }

  for (const row of await loadRows('carer_tasks_cache')) {
    const rowRaw = raw(row);
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const userUid = cleanText(row.completed_by_carer_uid || row.assigned_carer_uid || rowRaw.actorUid);
    if (cashBoxDelta == null || !userUid) continue;
    const reason = cleanText(rowRaw.rewardReason);
    const eventType = reason === 'username_task_completion'
      ? 'username_reward_cashbox_credit'
      : 'recharge_redeem_reward_cashbox_credit';
    const id = cleanText(row.firebase_id);
    add(events, makeEvent({ eventKey: `carerTasks:${id}:${userUid}:cashBoxNpr:${eventType}`, userUid, balanceType: 'cashBoxNpr', delta: cashBoxDelta, absoluteAfter: rowRaw.cashBoxAfter, eventType, reasonType: reason, sourceCollection: 'carer_tasks_cache', sourceId: id, sourceType: row.type, relatedTaskId: id, relatedRequestId: row.request_id || rowRaw.sourceRequestId, actorUid: rowRaw.actorUid, actorRole: rowRaw.actorRole, confidence: 'high', sourceCreatedAt: row.completed_at || row.updated_at || row.created_at, rawSourceData: rowRaw, sourceFields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta, rewardAmountNpr: rowRaw.rewardAmountNpr } }, profiles));
  }

  for (const row of await loadRows('carer_cashouts_cache')) {
    const rowRaw = raw(row);
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const userUid = cleanText(row.carer_uid || row.worker_uid);
    if (cashBoxDelta == null || !userUid) continue;
    const reason = cleanText(rowRaw.rewardReason);
    const eventType =
      reason === 'claim_pay_decline' ? 'claim_pay_cashbox_refund' :
      reason === 'claim_pay_complete' ? 'claim_pay_remaining_set' :
      'claim_pay_cashbox_debit';
    const id = cleanText(row.firebase_id);
    add(events, makeEvent({ eventKey: `carerCashouts:${id}:${userUid}:cashBoxNpr:${eventType}`, userUid, balanceType: 'cashBoxNpr', delta: cashBoxDelta, absoluteAfter: rowRaw.cashBoxAfter, eventType, reasonType: reason, sourceCollection: 'carer_cashouts_cache', sourceId: id, relatedRewardId: id, actorUid: rowRaw.actorUid, actorRole: rowRaw.actorRole, confidence: 'high', sourceCreatedAt: row.completed_at || row.created_at, rawSourceData: rowRaw, sourceFields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta, payoutAmountNpr: rowRaw.payoutAmountNpr, remainingAmountNpr: rowRaw.remainingAmountNpr } }, profiles));
  }

  for (const row of await loadRows('reward_cuts_cache')) {
    const rowRaw = raw(row);
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const userUid = cleanText(row.worker_uid);
    if (cashBoxDelta == null || !userUid) {
      if (!includeLowConfidence) continue;
      const amount = num(row.amount_npr);
      if (amount == null || !userUid) continue;
      const id = cleanText(row.firebase_id);
      add(events, makeEvent({ eventKey: `rewardCuts:${id}:${userUid}:cashBoxNpr:worker_reward_cut_cashbox_debit`, userUid, balanceType: 'cashBoxNpr', delta: -amount, eventType: 'worker_reward_cut_cashbox_debit', sourceCollection: 'reward_cuts_cache', sourceId: id, actorUid: row.created_by_uid, actorRole: 'coadmin', confidence: 'low', confidenceReason: 'Historical reward cut lacks actual cashBoxDelta; requested amount may exceed actual debit.', sourceCreatedAt: row.created_at, rawSourceData: rowRaw, sourceFields: { amountNpr: amount } }, profiles));
      continue;
    }
    const id = cleanText(row.firebase_id);
    add(events, makeEvent({ eventKey: `rewardCuts:${id}:${userUid}:cashBoxNpr:worker_reward_cut_cashbox_debit`, userUid, balanceType: 'cashBoxNpr', delta: cashBoxDelta, absoluteAfter: rowRaw.cashBoxAfter, eventType: 'worker_reward_cut_cashbox_debit', reasonType: rowRaw.rewardReason || row.reason, sourceCollection: 'reward_cuts_cache', sourceId: id, actorUid: rowRaw.actorUid || row.created_by_uid, actorRole: rowRaw.actorRole || 'coadmin', confidence: 'high', sourceCreatedAt: row.created_at, rawSourceData: rowRaw, sourceFields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta, amountNpr: row.amount_npr } }, profiles));
  }

  return events.filter((event) => includeLowConfidence || event.confidence !== 'low');
}

function summarize(events: UserBalanceEventInput[]) {
  const countsByEventType: Record<string, number> = {};
  const countsByConfidence: Record<string, number> = {};
  for (const event of events) {
    countsByEventType[event.eventType] = (countsByEventType[event.eventType] || 0) + 1;
    countsByConfidence[event.confidence] = (countsByConfidence[event.confidence] || 0) + 1;
  }
  return { countsByEventType, countsByConfidence };
}

export async function rebuildUserBalanceEventsDryRun(options: RebuildOptions = {}) {
  const events = await buildUserBalanceEventsFromMirrors(options);
  return {
    baselineWouldUpsert: events.filter((event) => event.isBaseline).length,
    derivedWouldUpsert: events.filter((event) => !event.isBaseline).length,
    ...summarize(events),
  };
}

export async function rebuildUserBalanceEvents(options: RebuildOptions = {}) {
  const db = getPlayerMirrorPool();
  if (!db) return { baselineUpserted: 0, derivedUpserted: 0, errors: 0 };
  if (options.clearExisting) {
    await db.query('UPDATE public.user_balance_events SET deleted_at = now(), derived_at = now() WHERE deleted_at IS NULL');
  }
  const events = await buildUserBalanceEventsFromMirrors(options);
  let baselineUpserted = 0;
  let derivedUpserted = 0;
  let errors = 0;
  for (const event of events) {
    const ok = await upsertUserBalanceEvent({ ...event, createdByBackfill: true });
    if (ok && event.isBaseline) baselineUpserted += 1;
    else if (ok) derivedUpserted += 1;
    else errors += 1;
  }
  return { baselineUpserted, derivedUpserted, errors, ...summarize(events) };
}
