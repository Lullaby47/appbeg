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

export async function mirrorReferralCodeByCode(code: string, source = 'appbeg') {
  const cleanCode = cleanText(code);
  if (!cleanCode) return false;
  try {
    const snap = await adminDb.collection('referralCodes').doc(cleanCode).get();
    if (!snap.exists) return false;
    return mirrorReferralCodeSnapshot(snap, source);
  } catch (error) {
    console.error('[REFERRALS_CACHE] mirror failed', { code: cleanCode, error });
    return false;
  }
}

export async function mirrorReferralCodeSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  const db = getPlayerMirrorPool();
  if (!db) return false;
  const data = (snap.data() || {}) as Record<string, unknown>;
  try {
    await db.query(
      `
        INSERT INTO public.referral_codes_cache (
          code, player_uid, created_at, raw_firestore_data, source, mirrored_at, deleted_at
        )
        VALUES ($1, NULLIF($2, ''), $3::timestamptz, $4::jsonb, $5, now(), NULL)
        ON CONFLICT (code) DO UPDATE SET
          player_uid = EXCLUDED.player_uid,
          created_at = COALESCE(public.referral_codes_cache.created_at, EXCLUDED.created_at),
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        snap.id,
        cleanText(data.playerUid),
        toIsoString(data.createdAt),
        JSON.stringify(normalizeJson(data) || {}),
        source,
      ]
    );
    console.info('[REFERRALS_CACHE] mirror upsert ok', { kind: 'referral_code', code: snap.id });
    return true;
  } catch (error) {
    console.error('[REFERRALS_CACHE] mirror failed', { kind: 'referral_code', code: snap.id, error });
    return false;
  }
}

export async function tombstoneReferralCodeCache(code: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanCode = cleanText(code);
  if (!db || !cleanCode) return false;
  try {
    await db.query(
      `
        INSERT INTO public.referral_codes_cache (code, raw_firestore_data, source, mirrored_at, deleted_at)
        VALUES ($1, '{}'::jsonb, $2, now(), now())
        ON CONFLICT (code) DO UPDATE SET source = EXCLUDED.source, mirrored_at = now(), deleted_at = now()
      `,
      [cleanCode, source]
    );
    return true;
  } catch (error) {
    console.error('[REFERRALS_CACHE] tombstone failed', { kind: 'referral_code', code: cleanCode, error });
    return false;
  }
}

export async function mirrorReferralSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  const db = getPlayerMirrorPool();
  if (!db) return false;
  const data = (snap.data() || {}) as Record<string, unknown>;
  try {
    await db.query(
      `
        INSERT INTO public.referrals_cache (
          firebase_id, referrer_uid, referrer_username, referred_player_uid,
          referred_player_username, referral_code, reward_coins, status,
          created_at, qualified_at, claimed_at, raw_firestore_data, source, mirrored_at, deleted_at
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), $7, NULLIF($8, ''), $9::timestamptz, $10::timestamptz,
          $11::timestamptz, $12::jsonb, $13, now(), NULL
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          referrer_uid = EXCLUDED.referrer_uid,
          referrer_username = EXCLUDED.referrer_username,
          referred_player_uid = EXCLUDED.referred_player_uid,
          referred_player_username = EXCLUDED.referred_player_username,
          referral_code = EXCLUDED.referral_code,
          reward_coins = EXCLUDED.reward_coins,
          status = EXCLUDED.status,
          created_at = COALESCE(public.referrals_cache.created_at, EXCLUDED.created_at),
          qualified_at = EXCLUDED.qualified_at,
          claimed_at = EXCLUDED.claimed_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        snap.id,
        cleanText(data.referrerUid),
        cleanText(data.referrerUsername),
        cleanText(data.referredPlayerUid),
        cleanText(data.referredPlayerUsername),
        cleanText(data.referralCode),
        numberOrNull(data.rewardCoins),
        cleanText(data.status),
        toIsoString(data.createdAt),
        toIsoString(data.qualifiedAt),
        toIsoString(data.claimedAt),
        JSON.stringify(normalizeJson(data) || {}),
        source,
      ]
    );
    console.info('[REFERRALS_CACHE] mirror upsert ok', { kind: 'referral', id: snap.id });
    return true;
  } catch (error) {
    console.error('[REFERRALS_CACHE] mirror failed', { kind: 'referral', id: snap.id, error });
    return false;
  }
}

export async function mirrorReferralById(id: string, source = 'appbeg') {
  const cleanId = cleanText(id);
  if (!cleanId) return false;
  try {
    return mirrorReferralSnapshot(await adminDb.collection('referrals').doc(cleanId).get(), source);
  } catch (error) {
    console.error('[REFERRALS_CACHE] mirror failed', { id: cleanId, error });
    return false;
  }
}
