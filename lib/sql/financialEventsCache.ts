import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  numberOrNull,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type FinancialEventCacheInput = {
  firebaseId: string;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
} & Record<string, unknown>;

function jsonObjectOrNull(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeJson(value) || {};
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies FinancialEventCacheInput;
}

export async function upsertFinancialEventCache(input: FinancialEventCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, player_uid, player_id, coadmin_uid, actor_uid,
          actor_username, actor_role, related_user_uid, related_user_role, type,
          amount, amount_npr, amount_coins, currency, unit, request_id,
          cashout_task_id, transfer_request_id, task_id, automation_job_id,
          bonus_event_id, gift_id, transfer_id, fee_amount, tip_amount,
          cash_received, coins_received, before_cash, after_cash, before_coin,
          after_coin, before_balances, after_balances, reason, notes, meta,
          created_at, updated_at, ttl_expires_at, source, mirrored_at, deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''),
          $11, $12, $13, NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''),
          NULLIF($17, ''), NULLIF($18, ''), NULLIF($19, ''), NULLIF($20, ''),
          NULLIF($21, ''), NULLIF($22, ''), NULLIF($23, ''), $24, $25,
          $26, $27, $28, $29, $30,
          $31, $32::jsonb, $33::jsonb, NULLIF($34, ''), NULLIF($35, ''), $36::jsonb,
          $37::timestamptz, $38::timestamptz, $39::timestamptz, $40, now(), NULL,
          $41::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          player_uid = EXCLUDED.player_uid,
          player_id = EXCLUDED.player_id,
          coadmin_uid = EXCLUDED.coadmin_uid,
          actor_uid = EXCLUDED.actor_uid,
          actor_username = EXCLUDED.actor_username,
          actor_role = EXCLUDED.actor_role,
          related_user_uid = EXCLUDED.related_user_uid,
          related_user_role = EXCLUDED.related_user_role,
          type = EXCLUDED.type,
          amount = EXCLUDED.amount,
          amount_npr = EXCLUDED.amount_npr,
          amount_coins = EXCLUDED.amount_coins,
          currency = EXCLUDED.currency,
          unit = EXCLUDED.unit,
          request_id = EXCLUDED.request_id,
          cashout_task_id = EXCLUDED.cashout_task_id,
          transfer_request_id = EXCLUDED.transfer_request_id,
          task_id = EXCLUDED.task_id,
          automation_job_id = EXCLUDED.automation_job_id,
          bonus_event_id = EXCLUDED.bonus_event_id,
          gift_id = EXCLUDED.gift_id,
          transfer_id = EXCLUDED.transfer_id,
          fee_amount = EXCLUDED.fee_amount,
          tip_amount = EXCLUDED.tip_amount,
          cash_received = EXCLUDED.cash_received,
          coins_received = EXCLUDED.coins_received,
          before_cash = EXCLUDED.before_cash,
          after_cash = EXCLUDED.after_cash,
          before_coin = EXCLUDED.before_coin,
          after_coin = EXCLUDED.after_coin,
          before_balances = EXCLUDED.before_balances,
          after_balances = EXCLUDED.after_balances,
          reason = EXCLUDED.reason,
          notes = EXCLUDED.notes,
          meta = EXCLUDED.meta,
          created_at = COALESCE(public.financial_events_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          ttl_expires_at = EXCLUDED.ttl_expires_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.playerUid || input.playerId),
        cleanText(input.playerId),
        cleanText(input.coadminUid || input.createdBy),
        cleanText(input.actorUid || input.createdByUid || input.adminUid || input.staffUid),
        cleanText(input.actorUsername || input.createdByUsername),
        cleanText(input.actorRole || input.createdByRole),
        cleanText(input.relatedUserUid || input.targetUid || input.userUid),
        cleanText(input.relatedUserRole || input.targetRole || input.userRole),
        cleanText(input.type || input.eventType),
        numberOrNull(input.amount ?? input.transferAmount),
        numberOrNull(input.amountNpr ?? input.nprAmount ?? input.transferAmount),
        numberOrNull(input.amountCoins ?? input.coinsAmount),
        cleanText(input.currency),
        cleanText(input.unit),
        cleanText(input.requestId || input.playerGameRequestId),
        cleanText(input.cashoutTaskId || input.playerCashoutTaskId),
        cleanText(input.transferRequestId),
        cleanText(input.taskId || input.carerTaskId),
        cleanText(input.automationJobId || input.jobId),
        cleanText(input.bonusEventId),
        cleanText(input.giftId || input.freeplayGiftId),
        cleanText(input.transferId),
        numberOrNull(input.feeAmount ?? input.feeNpr),
        numberOrNull(input.tipAmount ?? input.tipNpr),
        numberOrNull(input.cashReceived),
        numberOrNull(input.coinsReceived),
        numberOrNull(input.beforeCash),
        numberOrNull(input.afterCash),
        numberOrNull(input.beforeCoin ?? input.beforeCoins),
        numberOrNull(input.afterCoin ?? input.afterCoins),
        JSON.stringify(jsonObjectOrNull(input.beforeBalances)),
        JSON.stringify(jsonObjectOrNull(input.afterBalances)),
        cleanText(input.reason || input.reasonCode),
        cleanText(input.notes || input.note),
        JSON.stringify(jsonObjectOrNull(input.meta || input.metadata)),
        toIsoString(input.createdAt || input.timestamp),
        toIsoString(input.updatedAt),
        toIsoString(input.ttlExpiresAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[FINANCIAL_EVENTS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[FINANCIAL_EVENTS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorFinancialEventSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertFinancialEventCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorFinancialEventById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorFinancialEventSnapshot(
      await adminDb.collection('financialEvents').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[FINANCIAL_EVENTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstoneFinancialEventCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES ($1, $2, now(), now(), '{}'::jsonb)
        ON CONFLICT (firebase_id) DO UPDATE SET
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = now()
      `,
      [cleanId, source]
    );
    console.info('[FINANCIAL_EVENTS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[FINANCIAL_EVENTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function getFinancialEventCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.financial_events_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[FINANCIAL_EVENTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
