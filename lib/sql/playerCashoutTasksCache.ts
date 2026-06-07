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

export type PlayerCashoutTaskCacheInput = {
  firebaseId: string;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
} & Record<string, unknown>;

function booleanOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function jsonArrayOrNull(value: unknown) {
  if (!Array.isArray(value)) return null;
  return normalizeJson(value) || [];
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies PlayerCashoutTaskCacheInput;
}

export async function upsertPlayerCashoutTaskCache(input: PlayerCashoutTaskCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
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
        firebaseId,
        cleanText(input.coadminUid || input.createdBy),
        cleanText(input.playerUid || input.playerId),
        cleanText(input.playerUsername || input.username),
        numberOrNull(input.amountNpr ?? input.amount),
        cleanText(input.paymentDetails),
        cleanText(input.payoutMethod),
        cleanText(input.qrImageUrl),
        cleanText(input.paymentAppName),
        cleanText(input.paymentAppCashTag),
        cleanText(input.paymentAppAccountName),
        booleanOrNull(input.cashDeductedOnRequest),
        cleanText(input.status),
        cleanText(input.assignedHandlerUid),
        cleanText(input.assignedHandlerUsername),
        cleanText(input.cashoutRequestedByStaffId),
        numberOrNull(input.rewardNprApplied),
        booleanOrNull(input.rewardBlockedApplied),
        JSON.stringify(jsonArrayOrNull(input.declinedByUids)),
        toIsoString(input.startedAt),
        toIsoString(input.expiresAt),
        toIsoString(input.createdAt),
        toIsoString(input.completedAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[PLAYER_CASHOUT_TASKS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorPlayerCashoutTaskSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertPlayerCashoutTaskCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorPlayerCashoutTaskById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorPlayerCashoutTaskSnapshot(
      await adminDb.collection('playerCashoutTasks').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstonePlayerCashoutTaskCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.player_cashout_tasks_cache (
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
    console.info('[PLAYER_CASHOUT_TASKS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function getPlayerCashoutTaskCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.player_cashout_tasks_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[PLAYER_CASHOUT_TASKS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
