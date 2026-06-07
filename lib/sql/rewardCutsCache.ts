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

export type RewardCutCacheInput = {
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
  } satisfies RewardCutCacheInput;
}

export async function upsertRewardCutCache(input: RewardCutCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.reward_cuts_cache (
          firebase_id, coadmin_uid, worker_uid, worker_role, worker_username,
          amount_npr, reason, created_by_uid, created_at, source, mirrored_at,
          deleted_at, raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          $6, NULLIF($7, ''), NULLIF($8, ''), $9::timestamptz, $10,
          now(), NULL, $11::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          coadmin_uid = EXCLUDED.coadmin_uid,
          worker_uid = EXCLUDED.worker_uid,
          worker_role = EXCLUDED.worker_role,
          worker_username = EXCLUDED.worker_username,
          amount_npr = EXCLUDED.amount_npr,
          reason = EXCLUDED.reason,
          created_by_uid = EXCLUDED.created_by_uid,
          created_at = COALESCE(public.reward_cuts_cache.created_at, EXCLUDED.created_at),
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.coadminUid),
        cleanText(input.workerUid),
        cleanText(input.workerRole),
        cleanText(input.workerUsername),
        numberOrNull(input.amountNpr),
        cleanText(input.reason),
        cleanText(input.createdByUid),
        toIsoString(input.createdAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[REWARD_CUTS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[REWARD_CUTS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorRewardCutSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertRewardCutCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorRewardCutById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorRewardCutSnapshot(
      await adminDb.collection('rewardCuts').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[REWARD_CUTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstoneRewardCutCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.reward_cuts_cache (
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
    console.info('[REWARD_CUTS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[REWARD_CUTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function getRewardCutCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.reward_cuts_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[REWARD_CUTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
