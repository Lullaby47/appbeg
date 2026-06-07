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

export type UserBalanceSnapshotCacheInput = {
  firebaseId: string;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
} & Record<string, unknown>;

function boolOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies UserBalanceSnapshotCacheInput;
}

export async function upsertUserBalanceSnapshotCache(input: UserBalanceSnapshotCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.user_balance_snapshots_cache (
          firebase_id, username, email, role, status, coadmin_uid, created_by,
          coin, cash, cash_box_npr, promo_locked_coins, referral_bonus_coins,
          redeem_window_24h, reward_blocked, bonus_blocked_until,
          transfer_blocked_until, created_at, updated_at, source, mirrored_at,
          deleted_at, raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11, $12, $13, $14,
          $15::timestamptz, $16::timestamptz, $17::timestamptz,
          $18::timestamptz, $19, now(), NULL, $20::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          coadmin_uid = EXCLUDED.coadmin_uid,
          created_by = EXCLUDED.created_by,
          coin = EXCLUDED.coin,
          cash = EXCLUDED.cash,
          cash_box_npr = EXCLUDED.cash_box_npr,
          promo_locked_coins = EXCLUDED.promo_locked_coins,
          referral_bonus_coins = EXCLUDED.referral_bonus_coins,
          redeem_window_24h = EXCLUDED.redeem_window_24h,
          reward_blocked = EXCLUDED.reward_blocked,
          bonus_blocked_until = EXCLUDED.bonus_blocked_until,
          transfer_blocked_until = EXCLUDED.transfer_blocked_until,
          created_at = COALESCE(public.user_balance_snapshots_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.username),
        cleanText(input.email),
        cleanText(input.role),
        cleanText(input.status),
        cleanText(input.coadminUid),
        cleanText(input.createdBy),
        numberOrNull(input.coin),
        numberOrNull(input.cash),
        numberOrNull(input.cashBoxNpr),
        numberOrNull(input.promoLockedCoins),
        numberOrNull(input.referralBonusCoins),
        numberOrNull(input.redeemWindow24h),
        boolOrNull(input.rewardBlocked),
        toIsoString(input.bonusBlockedUntil),
        toIsoString(input.transferBlockedUntil),
        toIsoString(input.createdAt),
        toIsoString(input.updatedAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[USER_BALANCE_SNAPSHOTS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[USER_BALANCE_SNAPSHOTS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorUserBalanceSnapshotSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertUserBalanceSnapshotCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorUserBalanceSnapshotById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorUserBalanceSnapshotSnapshot(
      await adminDb.collection('users').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[USER_BALANCE_SNAPSHOTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstoneUserBalanceSnapshotCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.user_balance_snapshots_cache (
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
    console.info('[USER_BALANCE_SNAPSHOTS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[USER_BALANCE_SNAPSHOTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function getUserBalanceSnapshotCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.user_balance_snapshots_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[USER_BALANCE_SNAPSHOTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
