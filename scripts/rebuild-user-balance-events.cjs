const { Pool } = require('pg');

function argValue(name) {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  const hit = index >= 0 ? process.argv[index] : null;
  if (!hit) return null;
  if (hit === name) {
    const next = process.argv[index + 1];
    return next && !next.startsWith('--') ? next : 'true';
  }
  return hit.slice(prefix.length);
}

const DRY_RUN = argValue('--dry-run') !== null;
const ONLY_BASELINE = argValue('--only-baseline') !== null;
const ONLY_DERIVED = argValue('--only-derived') !== null;
const INCLUDE_LOW_CONFIDENCE = argValue('--include-low-confidence') !== null;
const CLEAR_EXISTING = argValue('--clear-existing') !== null;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function clean(value) {
  return String(value || '').trim();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createPgPool() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (connectionString) return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  return new Pool({
    host: clean(process.env.APPBEG_PG_HOST || '127.0.0.1'),
    port: Number(process.env.APPBEG_PG_PORT || '5433'),
    database: clean(process.env.APPBEG_PG_DATABASE || 'appbeg'),
    user: clean(process.env.APPBEG_PG_USER || 'appbeg_user'),
    password: requiredEnv('APPBEG_PG_PASSWORD'),
    connectionTimeoutMillis: 10_000,
  });
}

function normalizeJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function raw(row) {
  return normalizeJson(row.raw_firestore_data);
}

function profileFor(profiles, userUid, fallback = {}) {
  const found = profiles.get(userUid) || {};
  return {
    username: found.username || fallback.username || null,
    role: found.role || fallback.role || null,
    coadmin_uid: found.coadmin_uid || found.coadminUid || fallback.coadmin_uid || fallback.coadminUid || null,
  };
}

function makeEvent(input, profiles, fallbackProfile) {
  const userUid = clean(input.user_uid);
  const eventKey = clean(input.event_key);
  const sourceId = clean(input.source_id);
  if (!userUid || !eventKey || !sourceId) return null;
  const delta = num(input.delta);
  const direction = input.direction || (delta == null ? 'set' : delta < 0 ? 'debit' : delta > 0 ? 'credit' : 'set');
  const profile = profileFor(profiles, userUid, fallbackProfile);
  return {
    event_key: eventKey,
    user_uid: userUid,
    username: input.username ?? profile.username,
    role: input.role ?? profile.role,
    coadmin_uid: input.coadmin_uid ?? profile.coadmin_uid,
    balance_type: input.balance_type,
    direction,
    delta,
    absolute_after: num(input.absolute_after),
    event_type: input.event_type,
    reason_type: clean(input.reason_type) || null,
    source_collection: input.source_collection,
    source_id: sourceId,
    source_type: clean(input.source_type) || null,
    related_player_uid: clean(input.related_player_uid) || null,
    related_request_id: clean(input.related_request_id) || null,
    related_task_id: clean(input.related_task_id) || null,
    related_cashout_task_id: clean(input.related_cashout_task_id) || null,
    related_transfer_request_id: clean(input.related_transfer_request_id) || null,
    related_reward_id: clean(input.related_reward_id) || null,
    related_claim_id: clean(input.related_claim_id) || null,
    related_job_id: clean(input.related_job_id) || null,
    actor_uid: clean(input.actor_uid) || null,
    actor_role: clean(input.actor_role) || null,
    confidence: input.confidence,
    confidence_reason: clean(input.confidence_reason) || null,
    source_created_at: input.source_created_at || null,
    is_baseline: Boolean(input.is_baseline),
    is_residual_adjustment: Boolean(input.is_residual_adjustment),
    raw_source_data: normalizeJson(input.raw_source_data),
    source_fields: normalizeJson(input.source_fields),
  };
}

function add(events, event) {
  if (event) events.push(event);
}

async function loadRows(pool, table) {
  const result = await pool.query(`SELECT * FROM public.${table} WHERE deleted_at IS NULL`);
  return result.rows;
}

async function buildEvents(pool) {
  const events = [];
  const profiles = new Map();
  const snapshots = await loadRows(pool, 'user_balance_snapshots_cache');
  for (const row of snapshots) profiles.set(clean(row.firebase_id), row);

  if (!ONLY_DERIVED) {
    for (const row of snapshots) {
      const userUid = clean(row.firebase_id);
      for (const [column, balanceType] of [
        ['coin', 'coin'],
        ['cash', 'cash'],
        ['cash_box_npr', 'cashBoxNpr'],
        ['promo_locked_coins', 'promoLockedCoins'],
        ['referral_bonus_coins', 'referralBonusCoins'],
      ]) {
        const value = num(row[column]);
        if (value == null) continue;
        add(events, makeEvent({
          event_key: `baseline:${userUid}:${balanceType}`,
          user_uid: userUid,
          balance_type: balanceType,
          direction: 'baseline',
          delta: 0,
          absolute_after: value,
          event_type: 'baseline_snapshot',
          source_collection: 'user_balance_snapshots_cache',
          source_id: userUid,
          confidence: 'baseline',
          confidence_reason: 'Latest mirrored user balance snapshot.',
          source_created_at: row.updated_at || row.created_at || row.mirrored_at,
          is_baseline: true,
          raw_source_data: raw(row),
          source_fields: { value },
        }, profiles, row));
      }
    }
  }

  if (ONLY_BASELINE) return events;

  const financialRows = await loadRows(pool, 'financial_events_cache');
  const financialRequestKeys = new Set();
  const financialCashoutTaskKeys = new Set();
  const financialTransferRequestIds = new Set();
  for (const row of financialRows) {
    const type = clean(row.type);
    if (clean(row.request_id)) financialRequestKeys.add(`${clean(row.request_id)}:${type}`);
    if (clean(row.cashout_task_id)) financialCashoutTaskKeys.add(`${clean(row.cashout_task_id)}:${type}`);
    if (clean(row.transfer_request_id)) financialTransferRequestIds.add(clean(row.transfer_request_id));
  }

  for (const row of financialRows) {
    const id = clean(row.firebase_id);
    const type = clean(row.type);
    const userUid = clean(row.player_uid || row.player_id);
    const amount = num(row.amount_npr ?? row.amount ?? row.amount_coins) || 0;
    const rowRaw = raw(row);
    const common = {
      user_uid: userUid,
      source_collection: 'financial_events_cache',
      source_id: id,
      source_type: type,
      related_request_id: row.request_id,
      related_cashout_task_id: row.cashout_task_id,
      related_transfer_request_id: row.transfer_request_id,
      related_task_id: row.task_id,
      related_job_id: row.automation_job_id,
      actor_uid: row.actor_uid,
      actor_role: row.actor_role,
      source_created_at: row.created_at,
      raw_source_data: rowRaw,
    };
    if (type === 'recharge_request_deduct') add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:coin:recharge_request_coin_debit`, balance_type: 'coin', delta: -amount, event_type: 'recharge_request_coin_debit', confidence: 'medium', source_fields: { amount } }, profiles));
    else if (type === 'recharge_refund') add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:coin:recharge_refund_coin_credit`, balance_type: 'coin', delta: amount, event_type: 'recharge_refund_coin_credit', confidence: 'medium', source_fields: { amount } }, profiles));
    else if (type === 'redeem') add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:cash:redeem_cash_credit`, balance_type: 'cash', delta: amount, event_type: 'redeem_cash_credit', confidence: 'medium', source_fields: { amount } }, profiles));
    else if (type === 'cashout_request_deduct') add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:cash:cashout_request_cash_debit`, balance_type: 'cash', delta: -amount, event_type: 'cashout_request_cash_debit', confidence: 'medium', source_fields: { amount } }, profiles));
    else if (type === 'cashout_decline_refund') add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:cash:cashout_decline_cash_refund`, balance_type: 'cash', delta: amount, event_type: 'cashout_decline_cash_refund', confidence: 'medium', source_fields: { amount } }, profiles));
    else if (type === 'cash_to_coin_transfer' || type === 'coin_to_cash_transfer') {
      const cashDelta = (num(row.after_cash) ?? 0) - (num(row.before_cash) ?? 0);
      const coinDelta = (num(row.after_coin) ?? 0) - (num(row.before_coin) ?? 0);
      const cashType = type === 'cash_to_coin_transfer' ? 'cash_to_coin_cash_debit' : 'coin_to_cash_cash_credit';
      const coinType = type === 'cash_to_coin_transfer' ? 'cash_to_coin_coin_credit' : 'coin_to_cash_coin_debit';
      add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:cash:${cashType}`, balance_type: 'cash', delta: cashDelta, absolute_after: row.after_cash, event_type: cashType, confidence: 'high', source_fields: { beforeCash: row.before_cash, afterCash: row.after_cash } }, profiles));
      add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:coin:${coinType}`, balance_type: 'coin', delta: coinDelta, absolute_after: row.after_coin, event_type: coinType, confidence: 'high', source_fields: { beforeCoin: row.before_coin, afterCoin: row.after_coin } }, profiles));
    } else if (type === 'transfer') {
      add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:cash:legacy_transfer_cash_debit`, balance_type: 'cash', delta: -amount, event_type: 'legacy_transfer_cash_debit', confidence: 'medium', source_fields: { amount } }, profiles));
      add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:coin:legacy_transfer_coin_credit`, balance_type: 'coin', delta: amount, event_type: 'legacy_transfer_coin_credit', confidence: 'medium', source_fields: { amount } }, profiles));
    } else if (type === 'freeplay') {
      add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:coin:freeplay_coin_credit`, balance_type: 'coin', delta: amount, event_type: 'freeplay_coin_credit', confidence: 'medium', related_reward_id: row.gift_id, source_fields: { amount } }, profiles));
    } else if (type === 'coadmin_coin_add' || type === 'coadmin_coin_deduct') {
      add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:coin:manual_coin_adjust`, balance_type: 'coin', delta: type.endsWith('_deduct') ? -amount : amount, event_type: 'manual_coin_adjust', confidence: 'medium', source_fields: { amount, type } }, profiles));
    } else if (type === 'coadmin_cash_add' || type === 'coadmin_cash_deduct') {
      add(events, makeEvent({ ...common, event_key: `financialEvents:${id}:${userUid}:cash:manual_cash_adjust`, balance_type: 'cash', delta: type.endsWith('_deduct') ? -amount : amount, event_type: 'manual_cash_adjust', confidence: 'medium', source_fields: { amount, type } }, profiles));
    }
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const cashBoxUser = clean(rowRaw.staffUid || rowRaw.workerUid || rowRaw.carerUid || rowRaw.relatedUserUid);
    if (cashBoxDelta != null && cashBoxUser) {
      add(events, makeEvent({ ...common, user_uid: cashBoxUser, event_key: `financialEvents:${id}:${cashBoxUser}:cashBoxNpr:bonus_staff_cashbox_credit`, balance_type: 'cashBoxNpr', delta: cashBoxDelta, absolute_after: rowRaw.cashBoxAfter, event_type: 'bonus_staff_cashbox_credit', reason_type: rowRaw.rewardReason, confidence: 'high', confidence_reason: 'Source event contains cashBoxDelta audit fields.', source_fields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta } }, profiles));
    }
  }

  for (const row of await loadRows(pool, 'player_game_requests_cache')) {
    const id = clean(row.firebase_id);
    const type = clean(row.type);
    const status = clean(row.status);
    const userUid = clean(row.player_uid);
    const amount = num(row.base_amount) ?? num(row.amount) ?? 0;
    if (type === 'recharge' && row.coin_deducted_on_request === true && !financialRequestKeys.has(`${id}:recharge_request_deduct`)) add(events, makeEvent({ event_key: `playerGameRequests:${id}:${userUid}:coin:recharge_request_coin_debit`, user_uid: userUid, balance_type: 'coin', delta: -amount, event_type: 'recharge_request_coin_debit', source_collection: 'player_game_requests_cache', source_id: id, source_type: type, related_request_id: id, confidence: 'medium', confidence_reason: 'Mirrored request fallback; no matching financial event.', source_created_at: row.created_at, raw_source_data: raw(row), source_fields: { baseAmount: row.base_amount, amount: row.amount } }, profiles));
    if (type === 'recharge' && status === 'dismissed' && row.coin_refunded_on_dismissal === true && !financialRequestKeys.has(`${id}:recharge_refund`)) add(events, makeEvent({ event_key: `playerGameRequests:${id}:${userUid}:coin:recharge_refund_coin_credit`, user_uid: userUid, balance_type: 'coin', delta: amount, event_type: 'recharge_refund_coin_credit', source_collection: 'player_game_requests_cache', source_id: id, source_type: type, related_request_id: id, confidence: 'medium', confidence_reason: 'Mirrored request fallback; no matching financial event.', source_created_at: row.updated_at || row.created_at, raw_source_data: raw(row), source_fields: { baseAmount: row.base_amount, amount: row.amount } }, profiles));
    if (type === 'redeem' && status === 'completed' && !financialRequestKeys.has(`${id}:redeem`)) add(events, makeEvent({ event_key: `playerGameRequests:${id}:${userUid}:cash:redeem_cash_credit`, user_uid: userUid, balance_type: 'cash', delta: amount, event_type: 'redeem_cash_credit', source_collection: 'player_game_requests_cache', source_id: id, source_type: type, related_request_id: id, confidence: 'medium', confidence_reason: 'Mirrored request fallback; no matching financial event.', source_created_at: row.completed_at || row.updated_at || row.created_at, raw_source_data: raw(row), source_fields: { amount: row.amount } }, profiles));
    if (type === 'recharge' && status !== 'dismissed' && clean(row.bonus_event_id)) add(events, makeEvent({ event_key: `playerGameRequests:${id}:${userUid}:coin:bonus_play_coin_debit`, user_uid: userUid, balance_type: 'coin', delta: -amount, event_type: 'bonus_play_coin_debit', source_collection: 'player_game_requests_cache', source_id: id, source_type: type, related_request_id: id, confidence: 'medium', source_created_at: row.created_at, raw_source_data: raw(row), source_fields: { baseAmount: row.base_amount, amount: row.amount, bonusEventId: row.bonus_event_id } }, profiles));
  }

  for (const row of await loadRows(pool, 'player_cashout_tasks_cache')) {
    const id = clean(row.firebase_id);
    const status = clean(row.status);
    const amount = num(row.amount_npr) || 0;
    const userUid = clean(row.player_uid);
    if (row.cash_deducted_on_request === true && !financialCashoutTaskKeys.has(`${id}:cashout_request_deduct`)) add(events, makeEvent({ event_key: `playerCashoutTasks:${id}:${userUid}:cash:cashout_request_cash_debit`, user_uid: userUid, balance_type: 'cash', delta: -amount, event_type: 'cashout_request_cash_debit', source_collection: 'player_cashout_tasks_cache', source_id: id, related_cashout_task_id: id, confidence: 'medium', confidence_reason: 'Mirrored task fallback; no matching financial event.', source_created_at: row.created_at, raw_source_data: raw(row), source_fields: { amount } }, profiles));
    if (status === 'declined' && row.cash_deducted_on_request === true && !financialCashoutTaskKeys.has(`${id}:cashout_decline_refund`)) add(events, makeEvent({ event_key: `playerCashoutTasks:${id}:${userUid}:cash:cashout_decline_cash_refund`, user_uid: userUid, balance_type: 'cash', delta: amount, event_type: 'cashout_decline_cash_refund', source_collection: 'player_cashout_tasks_cache', source_id: id, related_cashout_task_id: id, confidence: 'medium', confidence_reason: 'Mirrored task fallback; no matching financial event.', source_created_at: row.completed_at || row.updated_at || row.created_at, raw_source_data: raw(row), source_fields: { amount } }, profiles));
    if (status === 'completed' && row.cash_deducted_on_request === false) add(events, makeEvent({ event_key: `playerCashoutTasks:${id}:${userUid}:cash:cashout_complete_cash_debit_legacy`, user_uid: userUid, balance_type: 'cash', delta: -amount, event_type: 'cashout_complete_cash_debit_legacy', source_collection: 'player_cashout_tasks_cache', source_id: id, related_cashout_task_id: id, confidence: 'medium', source_created_at: row.completed_at || row.created_at, raw_source_data: raw(row), source_fields: { amount } }, profiles));
    const rowRaw = raw(row);
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const handlerUid = clean(row.assigned_handler_uid);
    if (status === 'completed' && cashBoxDelta != null && handlerUid) add(events, makeEvent({ event_key: `playerCashoutTasks:${id}:${handlerUid}:cashBoxNpr:cashout_handler_cashbox_credit`, user_uid: handlerUid, balance_type: 'cashBoxNpr', delta: cashBoxDelta, absolute_after: rowRaw.cashBoxAfter, event_type: 'cashout_handler_cashbox_credit', source_collection: 'player_cashout_tasks_cache', source_id: id, related_cashout_task_id: id, actor_uid: rowRaw.actorUid, actor_role: rowRaw.actorRole, confidence: 'high', source_created_at: row.completed_at || row.created_at, raw_source_data: rowRaw, source_fields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta, rewardAmountNpr: rowRaw.rewardAmountNpr } }, profiles));
  }

  for (const row of await loadRows(pool, 'player_coin_rewards_cache')) {
    const id = clean(row.firebase_id);
    const fromUid = clean(row.from_uid);
    const toUid = clean(row.to_uid);
    add(events, makeEvent({ event_key: `playerCoinRewards:${id}:${fromUid}:coin:player_reward_coin_debit`, user_uid: fromUid, balance_type: 'coin', delta: -(num(row.amount_coins) || 0), event_type: 'player_reward_coin_debit', source_collection: 'player_coin_rewards_cache', source_id: id, related_reward_id: id, confidence: 'high', source_created_at: row.created_at, raw_source_data: raw(row), source_fields: { amountCoins: row.amount_coins, feeCoins: row.fee_coins } }, profiles));
    add(events, makeEvent({ event_key: `playerCoinRewards:${id}:${toUid}:coin:player_reward_coin_credit`, user_uid: toUid, balance_type: 'coin', delta: num(row.received_coins) || 0, event_type: 'player_reward_coin_credit', source_collection: 'player_coin_rewards_cache', source_id: id, related_reward_id: id, confidence: 'high', source_created_at: row.created_at, raw_source_data: raw(row), source_fields: { receivedCoins: row.received_coins } }, profiles));
  }

  for (const row of await loadRows(pool, 'referral_reward_claims_cache')) {
    if (clean(row.status) !== 'claimed') continue;
    const id = clean(row.firebase_id);
    const userUid = clean(row.referrer_uid);
    const amount = num(row.reward_amount) || 0;
    add(events, makeEvent({ event_key: `referralRewardClaims:${id}:${userUid}:coin:referral_reward_coin_credit`, user_uid: userUid, balance_type: 'coin', delta: amount, event_type: 'referral_reward_coin_credit', source_collection: 'referral_reward_claims_cache', source_id: id, related_claim_id: id, confidence: 'high', source_created_at: row.claimed_at || row.qualified_at, raw_source_data: raw(row), source_fields: { rewardAmount: amount } }, profiles));
    add(events, makeEvent({ event_key: `referralRewardClaims:${id}:${userUid}:promoLockedCoins:referral_reward_promo_locked_credit`, user_uid: userUid, balance_type: 'promoLockedCoins', delta: amount, event_type: 'referral_reward_promo_locked_credit', source_collection: 'referral_reward_claims_cache', source_id: id, related_claim_id: id, confidence: 'high', source_created_at: row.claimed_at || row.qualified_at, raw_source_data: raw(row), source_fields: { rewardAmount: amount } }, profiles));
  }

  for (const row of await loadRows(pool, 'transfer_requests_cache')) {
    const id = clean(row.firebase_id);
    if (financialTransferRequestIds.has(id)) continue;
    const status = clean(row.status);
    if (status !== 'approved' && status !== 'completed') continue;
    const userUid = clean(row.player_uid || row.user_uid);
    const amount = num(row.amount_npr ?? row.amount ?? row.amount_coins) || 0;
    add(events, makeEvent({ event_key: `transferRequests:${id}:${userUid}:cash:legacy_transfer_cash_debit`, user_uid: userUid, balance_type: 'cash', delta: -amount, event_type: 'legacy_transfer_cash_debit', source_collection: 'transfer_requests_cache', source_id: id, related_transfer_request_id: id, confidence: 'medium', confidence_reason: 'Approved mirrored transfer request fallback; no matching financial event.', source_created_at: row.completed_at || row.updated_at || row.created_at, raw_source_data: raw(row), source_fields: { amount } }, profiles));
    add(events, makeEvent({ event_key: `transferRequests:${id}:${userUid}:coin:legacy_transfer_coin_credit`, user_uid: userUid, balance_type: 'coin', delta: amount, event_type: 'legacy_transfer_coin_credit', source_collection: 'transfer_requests_cache', source_id: id, related_transfer_request_id: id, confidence: 'medium', confidence_reason: 'Approved mirrored transfer request fallback; no matching financial event.', source_created_at: row.completed_at || row.updated_at || row.created_at, raw_source_data: raw(row), source_fields: { amount } }, profiles));
  }

  for (const row of await loadRows(pool, 'carer_tasks_cache')) {
    const rowRaw = raw(row);
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const userUid = clean(row.completed_by_carer_uid || row.assigned_carer_uid || rowRaw.actorUid);
    if (cashBoxDelta == null || !userUid) continue;
    const reason = clean(rowRaw.rewardReason);
    const eventType = reason === 'username_task_completion' ? 'username_reward_cashbox_credit' : 'recharge_redeem_reward_cashbox_credit';
    const id = clean(row.firebase_id);
    add(events, makeEvent({ event_key: `carerTasks:${id}:${userUid}:cashBoxNpr:${eventType}`, user_uid: userUid, balance_type: 'cashBoxNpr', delta: cashBoxDelta, absolute_after: rowRaw.cashBoxAfter, event_type: eventType, reason_type: reason, source_collection: 'carer_tasks_cache', source_id: id, source_type: row.type, related_task_id: id, related_request_id: row.request_id || rowRaw.sourceRequestId, actor_uid: rowRaw.actorUid, actor_role: rowRaw.actorRole, confidence: 'high', source_created_at: row.completed_at || row.updated_at || row.created_at, raw_source_data: rowRaw, source_fields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta, rewardAmountNpr: rowRaw.rewardAmountNpr } }, profiles));
  }

  for (const row of await loadRows(pool, 'carer_cashouts_cache')) {
    const rowRaw = raw(row);
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const userUid = clean(row.carer_uid || row.worker_uid);
    if (cashBoxDelta == null || !userUid) continue;
    const reason = clean(rowRaw.rewardReason);
    const eventType = reason === 'claim_pay_decline' ? 'claim_pay_cashbox_refund' : reason === 'claim_pay_complete' ? 'claim_pay_remaining_set' : 'claim_pay_cashbox_debit';
    const id = clean(row.firebase_id);
    add(events, makeEvent({ event_key: `carerCashouts:${id}:${userUid}:cashBoxNpr:${eventType}`, user_uid: userUid, balance_type: 'cashBoxNpr', delta: cashBoxDelta, absolute_after: rowRaw.cashBoxAfter, event_type: eventType, reason_type: reason, source_collection: 'carer_cashouts_cache', source_id: id, related_reward_id: id, actor_uid: rowRaw.actorUid, actor_role: rowRaw.actorRole, confidence: 'high', source_created_at: row.completed_at || row.created_at, raw_source_data: rowRaw, source_fields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta, payoutAmountNpr: rowRaw.payoutAmountNpr, remainingAmountNpr: rowRaw.remainingAmountNpr } }, profiles));
  }

  for (const row of await loadRows(pool, 'reward_cuts_cache')) {
    const rowRaw = raw(row);
    const cashBoxDelta = num(rowRaw.cashBoxDelta);
    const userUid = clean(row.worker_uid);
    const id = clean(row.firebase_id);
    if (cashBoxDelta == null) {
      if (!INCLUDE_LOW_CONFIDENCE) continue;
      const amount = num(row.amount_npr);
      if (amount == null || !userUid) continue;
      add(events, makeEvent({ event_key: `rewardCuts:${id}:${userUid}:cashBoxNpr:worker_reward_cut_cashbox_debit`, user_uid: userUid, balance_type: 'cashBoxNpr', delta: -amount, event_type: 'worker_reward_cut_cashbox_debit', source_collection: 'reward_cuts_cache', source_id: id, actor_uid: row.created_by_uid, actor_role: 'coadmin', confidence: 'low', confidence_reason: 'Historical reward cut lacks actual cashBoxDelta; requested amount may exceed actual debit.', source_created_at: row.created_at, raw_source_data: rowRaw, source_fields: { amountNpr: amount } }, profiles));
      continue;
    }
    add(events, makeEvent({ event_key: `rewardCuts:${id}:${userUid}:cashBoxNpr:worker_reward_cut_cashbox_debit`, user_uid: userUid, balance_type: 'cashBoxNpr', delta: cashBoxDelta, absolute_after: rowRaw.cashBoxAfter, event_type: 'worker_reward_cut_cashbox_debit', reason_type: rowRaw.rewardReason || row.reason, source_collection: 'reward_cuts_cache', source_id: id, actor_uid: rowRaw.actorUid || row.created_by_uid, actor_role: rowRaw.actorRole || 'coadmin', confidence: 'high', source_created_at: row.created_at, raw_source_data: rowRaw, source_fields: { cashBoxBefore: rowRaw.cashBoxBefore, cashBoxAfter: rowRaw.cashBoxAfter, cashBoxDelta, amountNpr: row.amount_npr } }, profiles));
  }

  return events.filter((event) => INCLUDE_LOW_CONFIDENCE || event.confidence !== 'low');
}

function summarize(events) {
  const countsByEventType = {};
  const countsByConfidence = {};
  for (const event of events) {
    countsByEventType[event.event_type] = (countsByEventType[event.event_type] || 0) + 1;
    countsByConfidence[event.confidence] = (countsByConfidence[event.confidence] || 0) + 1;
  }
  return { counts_by_event_type: countsByEventType, counts_by_confidence: countsByConfidence };
}

async function upsert(pool, event) {
  await pool.query(
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
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
        $27::timestamptz, now(), $28, $29, true, $30::jsonb, $31::jsonb, NULL
      )
      ON CONFLICT (event_key) DO UPDATE SET
        user_uid=EXCLUDED.user_uid,
        username=EXCLUDED.username,
        role=EXCLUDED.role,
        coadmin_uid=EXCLUDED.coadmin_uid,
        balance_type=EXCLUDED.balance_type,
        direction=EXCLUDED.direction,
        delta=EXCLUDED.delta,
        absolute_after=EXCLUDED.absolute_after,
        event_type=EXCLUDED.event_type,
        reason_type=EXCLUDED.reason_type,
        source_collection=EXCLUDED.source_collection,
        source_id=EXCLUDED.source_id,
        source_type=EXCLUDED.source_type,
        related_player_uid=EXCLUDED.related_player_uid,
        related_request_id=EXCLUDED.related_request_id,
        related_task_id=EXCLUDED.related_task_id,
        related_cashout_task_id=EXCLUDED.related_cashout_task_id,
        related_transfer_request_id=EXCLUDED.related_transfer_request_id,
        related_reward_id=EXCLUDED.related_reward_id,
        related_claim_id=EXCLUDED.related_claim_id,
        related_job_id=EXCLUDED.related_job_id,
        actor_uid=EXCLUDED.actor_uid,
        actor_role=EXCLUDED.actor_role,
        confidence=EXCLUDED.confidence,
        confidence_reason=EXCLUDED.confidence_reason,
        source_created_at=EXCLUDED.source_created_at,
        derived_at=now(),
        is_baseline=EXCLUDED.is_baseline,
        is_residual_adjustment=EXCLUDED.is_residual_adjustment,
        created_by_backfill=true,
        raw_source_data=EXCLUDED.raw_source_data,
        source_fields=EXCLUDED.source_fields,
        deleted_at=NULL
    `,
    [
      event.event_key, event.user_uid, event.username, event.role, event.coadmin_uid,
      event.balance_type, event.direction, event.delta, event.absolute_after,
      event.event_type, event.reason_type, event.source_collection, event.source_id,
      event.source_type, event.related_player_uid, event.related_request_id,
      event.related_task_id, event.related_cashout_task_id, event.related_transfer_request_id,
      event.related_reward_id, event.related_claim_id, event.related_job_id, event.actor_uid,
      event.actor_role, event.confidence, event.confidence_reason, event.source_created_at,
      event.is_baseline, event.is_residual_adjustment, JSON.stringify(event.raw_source_data),
      JSON.stringify(event.source_fields),
    ]
  );
}

async function main() {
  const pool = createPgPool();
  const events = await buildEvents(pool);
  let baselineUpserted = 0;
  let derivedUpserted = 0;
  let errors = 0;

  if (!DRY_RUN && CLEAR_EXISTING) {
    await pool.query('UPDATE public.user_balance_events SET deleted_at = now(), derived_at = now() WHERE deleted_at IS NULL');
  }

  if (!DRY_RUN) {
    for (const event of events) {
      try {
        await upsert(pool, event);
        if (event.is_baseline) baselineUpserted += 1;
        else derivedUpserted += 1;
      } catch (error) {
        errors += 1;
        console.error('[REBUILD_USER_BALANCE_EVENTS] upsert failed', {
          event_key: event.event_key,
          error,
        });
      }
    }
  }

  await pool.end();
  console.log(JSON.stringify({
    dry_run: DRY_RUN,
    clear_existing: CLEAR_EXISTING,
    baseline_would_upsert: events.filter((event) => event.is_baseline).length,
    derived_would_upsert: events.filter((event) => !event.is_baseline).length,
    baseline_upserted: baselineUpserted,
    derived_upserted: derivedUpserted,
    skipped_low_confidence: INCLUDE_LOW_CONFIDENCE ? 0 : null,
    errors,
    ...summarize(events),
  }, null, 2));
}

main().catch((error) => {
  console.error('[REBUILD_USER_BALANCE_EVENTS] fatal', error);
  process.exitCode = 1;
});
