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

export type CarerCashoutCacheInput = {
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
  } satisfies CarerCashoutCacheInput;
}

export async function upsertCarerCashoutCache(input: CarerCashoutCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.carer_cashouts_cache (
          firebase_id, coadmin_uid, carer_uid, carer_username, worker_uid, worker_role,
          amount_npr, completed_amount_npr, remaining_amount_npr, payment_qr_url,
          payment_qr_public_id, payment_details, status, created_at, completed_at,
          source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''),
          NULLIF($12, ''), NULLIF($13, ''), $14::timestamptz, $15::timestamptz,
          $16, now(), NULL, $17::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          coadmin_uid = EXCLUDED.coadmin_uid,
          carer_uid = EXCLUDED.carer_uid,
          carer_username = EXCLUDED.carer_username,
          worker_uid = EXCLUDED.worker_uid,
          worker_role = EXCLUDED.worker_role,
          amount_npr = EXCLUDED.amount_npr,
          completed_amount_npr = EXCLUDED.completed_amount_npr,
          remaining_amount_npr = EXCLUDED.remaining_amount_npr,
          payment_qr_url = EXCLUDED.payment_qr_url,
          payment_qr_public_id = EXCLUDED.payment_qr_public_id,
          payment_details = EXCLUDED.payment_details,
          status = EXCLUDED.status,
          created_at = COALESCE(public.carer_cashouts_cache.created_at, EXCLUDED.created_at),
          completed_at = EXCLUDED.completed_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.coadminUid),
        cleanText(input.carerUid),
        cleanText(input.carerUsername),
        cleanText(input.workerUid || input.carerUid),
        cleanText(input.workerRole),
        numberOrNull(input.amountNpr),
        numberOrNull(input.completedAmountNpr),
        numberOrNull(input.remainingAmountNpr),
        cleanText(input.paymentQrUrl),
        cleanText(input.paymentQrPublicId),
        cleanText(input.paymentDetails),
        cleanText(input.status),
        toIsoString(input.createdAt),
        toIsoString(input.completedAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[CARER_CASHOUTS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[CARER_CASHOUTS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorCarerCashoutSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertCarerCashoutCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorCarerCashoutById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorCarerCashoutSnapshot(
      await adminDb.collection('carerCashouts').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[CARER_CASHOUTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstoneCarerCashoutCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.carer_cashouts_cache (
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
    console.info('[CARER_CASHOUTS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[CARER_CASHOUTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export type CachedCarerCashout = {
  id: string;
  coadminUid: string;
  carerUid: string;
  carerUsername: string;
  amountNpr: number;
  paymentQrUrl: string | null;
  paymentQrPublicId: string | null;
  paymentDetails: string | null;
  status: string;
  completedAmountNpr: number | null;
  remainingAmountNpr: number | null;
  createdAt: string | null;
  completedAt: string | null;
};

function mapCachedCarerCashoutRow(row: Record<string, unknown>): CachedCarerCashout | null {
  const id = cleanText(row.firebase_id);
  const carerUid = cleanText(row.carer_uid);
  if (!id || !carerUid) {
    return null;
  }
  return {
    id,
    coadminUid: cleanText(row.coadmin_uid),
    carerUid,
    carerUsername: cleanText(row.carer_username),
    amountNpr: Number(row.amount_npr || 0),
    paymentQrUrl: cleanText(row.payment_qr_url) || null,
    paymentQrPublicId: cleanText(row.payment_qr_public_id) || null,
    paymentDetails: cleanText(row.payment_details) || null,
    status: cleanText(row.status) || 'pending',
    completedAmountNpr: numberOrNull(row.completed_amount_npr) ?? null,
    remainingAmountNpr: numberOrNull(row.remaining_amount_npr) ?? null,
    createdAt: toIsoString(row.created_at),
    completedAt: toIsoString(row.completed_at),
  };
}

export async function readPendingCarerCashoutsByCoadmin(
  coadminUid: string,
  limit = 100
): Promise<CachedCarerCashout[] | null> {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  if (!db || !cleanCoadminUid) {
    return null;
  }

  try {
    const startedAt = Date.now();
    const result = await db.query(
      `
        SELECT *
        FROM public.carer_cashouts_cache
        WHERE coadmin_uid = $1
          AND status = 'pending'
          AND deleted_at IS NULL
        ORDER BY created_at DESC NULLS LAST
        LIMIT $2
      `,
      [cleanCoadminUid, safeLimit]
    );
    const cashouts = result.rows
      .map((row) => mapCachedCarerCashoutRow(row as Record<string, unknown>))
      .filter((row): row is CachedCarerCashout => Boolean(row));
    console.info('[CARER_CASHOUTS_CACHE] pending read ok', {
      coadminUid: cleanCoadminUid,
      count: cashouts.length,
      durationMs: Date.now() - startedAt,
    });
    return cashouts;
  } catch (error) {
    console.warn('[CARER_CASHOUTS_CACHE] pending read failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
    return null;
  }
}

export async function readCarerCashoutsByCarerUid(carerUid: string, limit = 100) {
  const db = getPlayerMirrorPool();
  const cleanCarerUid = cleanText(carerUid);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  if (!db || !cleanCarerUid) {
    return null;
  }

  try {
    const result = await db.query(
      `
        SELECT *
        FROM public.carer_cashouts_cache
        WHERE carer_uid = $1
          AND deleted_at IS NULL
        ORDER BY COALESCE(completed_at, created_at) DESC NULLS LAST
        LIMIT $2
      `,
      [cleanCarerUid, safeLimit]
    );
    return result.rows
      .map((row) => mapCachedCarerCashoutRow(row as Record<string, unknown>))
      .filter((row): row is CachedCarerCashout => Boolean(row));
  } catch (error) {
    console.warn('[CARER_CASHOUTS_CACHE] carer history read failed', {
      carerUid: cleanCarerUid,
      error,
    });
    return null;
  }
}

export async function getCarerCashoutCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.carer_cashouts_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[CARER_CASHOUTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
