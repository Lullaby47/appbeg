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

export type TransferRequestCacheInput = {
  firebaseId: string;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
} & Record<string, unknown>;

function booleanOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null;
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    ...data,
    rawFirestoreData: data,
    source,
  } satisfies TransferRequestCacheInput;
}

export async function upsertTransferRequestCache(input: TransferRequestCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  try {
    await db.query(
      `
        INSERT INTO public.transfer_requests_cache (
          firebase_id, player_uid, player_username, coadmin_uid, amount_npr,
          cash_balance_snapshot, status, requested_by_uid, requested_by_username,
          requested_at, approved_by_uid, approved_by_username, approved_at,
          rejected_by_uid, rejected_by_username, rejected_at, rejection_reason,
          auto_approved, reviewed, processed_at, source, mirrored_at, deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), $5,
          $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''),
          $10::timestamptz, NULLIF($11, ''), NULLIF($12, ''), $13::timestamptz,
          NULLIF($14, ''), NULLIF($15, ''), $16::timestamptz, NULLIF($17, ''),
          $18, $19, $20::timestamptz, $21, now(), NULL,
          $22::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          player_uid = EXCLUDED.player_uid,
          player_username = EXCLUDED.player_username,
          coadmin_uid = EXCLUDED.coadmin_uid,
          amount_npr = EXCLUDED.amount_npr,
          cash_balance_snapshot = EXCLUDED.cash_balance_snapshot,
          status = EXCLUDED.status,
          requested_by_uid = EXCLUDED.requested_by_uid,
          requested_by_username = EXCLUDED.requested_by_username,
          requested_at = COALESCE(public.transfer_requests_cache.requested_at, EXCLUDED.requested_at),
          approved_by_uid = EXCLUDED.approved_by_uid,
          approved_by_username = EXCLUDED.approved_by_username,
          approved_at = EXCLUDED.approved_at,
          rejected_by_uid = EXCLUDED.rejected_by_uid,
          rejected_by_username = EXCLUDED.rejected_by_username,
          rejected_at = EXCLUDED.rejected_at,
          rejection_reason = EXCLUDED.rejection_reason,
          auto_approved = EXCLUDED.auto_approved,
          reviewed = EXCLUDED.reviewed,
          processed_at = EXCLUDED.processed_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        cleanText(input.playerUid || input.playerId),
        cleanText(input.playerUsername || input.username),
        cleanText(input.coadminUid || input.createdBy),
        numberOrNull(input.amountNpr ?? input.amount),
        numberOrNull(input.cashBalanceSnapshot),
        cleanText(input.status),
        cleanText(input.requestedByUid),
        cleanText(input.requestedByUsername),
        toIsoString(input.requestedAt || input.createdAt),
        cleanText(input.approvedByUid),
        cleanText(input.approvedByUsername),
        toIsoString(input.approvedAt),
        cleanText(input.rejectedByUid),
        cleanText(input.rejectedByUsername),
        toIsoString(input.rejectedAt),
        cleanText(input.rejectionReason),
        booleanOrNull(input.autoApproved),
        booleanOrNull(input.reviewed),
        toIsoString(input.processedAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[TRANSFER_REQUESTS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[TRANSFER_REQUESTS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorTransferRequestSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertTransferRequestCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorTransferRequestById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorTransferRequestSnapshot(
      await adminDb.collection('transferRequests').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[TRANSFER_REQUESTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstoneTransferRequestCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.transfer_requests_cache (
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
    console.info('[TRANSFER_REQUESTS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[TRANSFER_REQUESTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function getTransferRequestCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      'SELECT * FROM public.transfer_requests_cache WHERE firebase_id = $1 LIMIT 1',
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[TRANSFER_REQUESTS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}
