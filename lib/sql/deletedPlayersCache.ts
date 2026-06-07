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

export async function mirrorDeletedPlayerSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  const db = getPlayerMirrorPool();
  if (!db) return false;
  const data = (snap.data() || {}) as Record<string, unknown>;
  try {
    await db.query(
      `
        INSERT INTO public.deleted_players_cache (
          uid, username, email, role, status, created_by, coadmin_uid, coin, cash,
          referral_code, referred_by_uid, referred_by_code, referral_bonus_coins,
          referral_created_at, deleted_at_source, deleted_by_uid, raw_firestore_data,
          source, mirrored_at, deleted_at
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), NULLIF($7, ''), $8, $9, NULLIF($10, ''), NULLIF($11, ''),
          NULLIF($12, ''), $13, $14::timestamptz, $15::timestamptz, NULLIF($16, ''),
          $17::jsonb, $18, now(), NULL
        )
        ON CONFLICT (uid) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          created_by = EXCLUDED.created_by,
          coadmin_uid = EXCLUDED.coadmin_uid,
          coin = EXCLUDED.coin,
          cash = EXCLUDED.cash,
          referral_code = EXCLUDED.referral_code,
          referred_by_uid = EXCLUDED.referred_by_uid,
          referred_by_code = EXCLUDED.referred_by_code,
          referral_bonus_coins = EXCLUDED.referral_bonus_coins,
          referral_created_at = EXCLUDED.referral_created_at,
          deleted_at_source = EXCLUDED.deleted_at_source,
          deleted_by_uid = EXCLUDED.deleted_by_uid,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        snap.id,
        cleanText(data.username),
        cleanText(data.email),
        cleanText(data.role),
        cleanText(data.status),
        cleanText(data.createdBy),
        cleanText(data.coadminUid),
        numberOrNull(data.coin),
        numberOrNull(data.cash),
        cleanText(data.referralCode),
        cleanText(data.referredByUid),
        cleanText(data.referredByCode),
        numberOrNull(data.referralBonusCoins),
        toIsoString(data.referralCreatedAt),
        toIsoString(data.deletedAt),
        cleanText(data.deletedByUid),
        JSON.stringify(normalizeJson(data) || {}),
        source,
      ]
    );
    console.info('[DELETED_PLAYERS_CACHE] mirror upsert ok', { uid: snap.id });
    return true;
  } catch (error) {
    console.error('[DELETED_PLAYERS_CACHE] mirror failed', { uid: snap.id, error });
    return false;
  }
}

export async function mirrorDeletedPlayerById(uid: string, source = 'appbeg') {
  const cleanUid = cleanText(uid);
  if (!cleanUid) return false;
  try {
    return mirrorDeletedPlayerSnapshot(await adminDb.collection('deletedPlayers').doc(cleanUid).get(), source);
  } catch (error) {
    console.error('[DELETED_PLAYERS_CACHE] mirror failed', { uid: cleanUid, error });
    return false;
  }
}

export async function tombstoneDeletedPlayerCache(uid: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) return false;
  try {
    await db.query(
      `
        INSERT INTO public.deleted_players_cache (uid, raw_firestore_data, source, mirrored_at, deleted_at)
        VALUES ($1, '{}'::jsonb, $2, now(), now())
        ON CONFLICT (uid) DO UPDATE SET source = EXCLUDED.source, mirrored_at = now(), deleted_at = now()
      `,
      [cleanUid, source]
    );
    return true;
  } catch (error) {
    console.error('[DELETED_PLAYERS_CACHE] tombstone failed', { uid: cleanUid, error });
    return false;
  }
}
