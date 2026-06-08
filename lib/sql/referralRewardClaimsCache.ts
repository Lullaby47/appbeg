import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';
import type { PoolClient } from 'pg';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  numberOrNull,
  runMirrorClientQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type ReferralRewardClaimCacheInput = {
  firebaseId: string;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
} & Record<string, unknown>;

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies ReferralRewardClaimCacheInput;
}

export async function upsertReferralRewardClaimCache(input: ReferralRewardClaimCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.referral_reward_claims_cache (
          firebase_id, referrer_uid, referred_player_uid, referred_player_name,
          recharge_id, recharge_amount, reward_amount, status,
          qualified_at, claimed_at, source, mirrored_at, deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''),
          NULLIF($5, ''), $6, $7, NULLIF($8, ''),
          $9::timestamptz, $10::timestamptz, $11, now(), NULL,
          $12::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          referrer_uid = EXCLUDED.referrer_uid,
          referred_player_uid = EXCLUDED.referred_player_uid,
          referred_player_name = EXCLUDED.referred_player_name,
          recharge_id = EXCLUDED.recharge_id,
          recharge_amount = EXCLUDED.recharge_amount,
          reward_amount = EXCLUDED.reward_amount,
          status = EXCLUDED.status,
          qualified_at = EXCLUDED.qualified_at,
          claimed_at = EXCLUDED.claimed_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.referrerUid),
        cleanText(input.referredPlayerUid || input.playerUid),
        cleanText(input.referredPlayerName || input.playerUsername),
        cleanText(input.rechargeId),
        numberOrNull(input.rechargeAmount),
        numberOrNull(input.rewardAmount || input.rewardCoins),
        cleanText(input.status),
        toIsoString(input.qualifiedAt),
        toIsoString(input.claimedAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[REFERRAL_REWARD_CLAIMS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[REFERRAL_REWARD_CLAIMS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorReferralRewardClaimSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertReferralRewardClaimCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorReferralRewardClaimById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorReferralRewardClaimSnapshot(
      await adminDb.collection('referralRewardClaims').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[REFERRAL_REWARD_CLAIMS_CACHE] mirror failed', {
      firebaseId: cleanId,
      error,
    });
    return false;
  }
}

export async function tombstoneReferralRewardClaimCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.referral_reward_claims_cache (
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
    console.info('[REFERRAL_REWARD_CLAIMS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[REFERRAL_REWARD_CLAIMS_CACHE] mirror failed', {
      firebaseId: cleanId,
      error,
    });
    return false;
  }
}

const REFERRAL_REWARD_CLAIM_BY_ID_SQL =
  'SELECT * FROM public.referral_reward_claims_cache WHERE firebase_id = $1 LIMIT 1';

export async function getReferralRewardClaimCacheByIdWithClient(
  client: PoolClient,
  firebaseId: string
) {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return null;
  try {
    const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
      client,
      REFERRAL_REWARD_CLAIM_BY_ID_SQL,
      [cleanId]
    );
    return rows[0] || null;
  } catch (error) {
    console.error('[REFERRAL_REWARD_CLAIMS_CACHE] read failed', {
      firebaseId: cleanId,
      error,
    });
    return null;
  }
}

export async function getReferralRewardClaimCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(REFERRAL_REWARD_CLAIM_BY_ID_SQL, [cleanId]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('[REFERRAL_REWARD_CLAIMS_CACHE] mirror failed', {
      firebaseId: cleanId,
      error,
    });
    return null;
  }
}
