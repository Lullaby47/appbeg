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
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type FreeplayPendingGiftCacheInput = {
  playerUid: string;
  coadminUid?: unknown;
  giftId?: unknown;
  type?: unknown;
  status?: unknown;
  amount?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  claimedAt?: unknown;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
};

export type FreeplayPendingGiftCacheRow = {
  playerUid: string;
  coadminUid: string | null;
  giftId: string | null;
  hasPendingGift: boolean;
  status: string | null;
  amount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  claimedAt: string | null;
};

export type FreeplayPendingGiftCacheLookup = {
  missReason: 'postgres_unavailable' | 'row_missing' | null;
  row: FreeplayPendingGiftCacheRow | null;
};

function computeHasPendingGift(data: Record<string, unknown>) {
  return (
    cleanText(data.type).toLowerCase() === 'freeplay' &&
    cleanText(data.status).toLowerCase() === 'pending' &&
    Boolean(cleanText(data.giftId))
  );
}

function mapCacheRow(row: Record<string, unknown>): FreeplayPendingGiftCacheRow {
  const playerUid = cleanText(row.player_uid);
  const status = cleanText(row.status) || null;
  const giftId = cleanText(row.gift_id) || null;
  const hasPendingGift =
    row.has_pending_gift === true ||
    (status?.toLowerCase() === 'pending' && Boolean(giftId));

  return {
    playerUid,
    coadminUid: cleanText(row.coadmin_uid) || null,
    giftId,
    hasPendingGift,
    status,
    amount: numberOrNull(row.amount),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    claimedAt: toIsoString(row.claimed_at),
  };
}

function cacheInputFromFirestore(
  playerUid: string,
  data: Record<string, unknown>,
  source: string
): FreeplayPendingGiftCacheInput {
  const hasPending = computeHasPendingGift(data);
  const createdAt = data.createdAt;
  const claimedAt = data.claimedAt;
  const updatedAt = data.updatedAt ?? claimedAt ?? createdAt;

  return {
    playerUid,
    coadminUid: data.coadminUid,
    giftId: data.giftId,
    type: data.type,
    status: data.status,
    amount: data.amount,
    createdAt,
    updatedAt,
    claimedAt,
    rawFirestoreData: data,
    source,
  };
}

export async function upsertFreeplayPendingGiftCache(
  input: FreeplayPendingGiftCacheInput
): Promise<boolean> {
  const db = getPlayerMirrorPool();
  const playerUid = cleanText(input.playerUid);
  if (!db || !playerUid) {
    return false;
  }

  const rawData = (input.rawFirestoreData || {}) as Record<string, unknown>;
  const status = cleanText(input.status ?? rawData.status);
  const giftId = cleanText(input.giftId ?? rawData.giftId);
  const type = cleanText(input.type ?? rawData.type);
  const hasPendingGift =
    cleanText(type).toLowerCase() === 'freeplay' &&
    status.toLowerCase() === 'pending' &&
    Boolean(giftId);

  try {
    await db.query(
      `
        INSERT INTO public.freeplay_pending_gifts_cache (
          player_uid, coadmin_uid, gift_id, has_pending_gift, status, amount,
          created_at, updated_at, claimed_at, source, mirrored_at, deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), $4, NULLIF($5, ''), $6,
          $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, now(), NULL,
          $11::jsonb
        )
        ON CONFLICT (player_uid) DO UPDATE SET
          coadmin_uid = EXCLUDED.coadmin_uid,
          gift_id = EXCLUDED.gift_id,
          has_pending_gift = EXCLUDED.has_pending_gift,
          status = EXCLUDED.status,
          amount = EXCLUDED.amount,
          created_at = COALESCE(EXCLUDED.created_at, public.freeplay_pending_gifts_cache.created_at),
          updated_at = EXCLUDED.updated_at,
          claimed_at = EXCLUDED.claimed_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        playerUid,
        cleanText(input.coadminUid ?? rawData.coadminUid),
        giftId,
        hasPendingGift,
        status || null,
        numberOrNull(input.amount ?? rawData.amount),
        toIsoString(input.createdAt ?? rawData.createdAt),
        toIsoString(input.updatedAt ?? rawData.updatedAt ?? rawData.claimedAt ?? rawData.createdAt),
        toIsoString(input.claimedAt ?? rawData.claimedAt),
        cleanText(input.source) || 'firestore',
        JSON.stringify(normalizeJson(input.rawFirestoreData || rawData) || {}),
      ]
    );
    console.info('[FREEPLAY_PENDING_CACHE] mirror upsert ok', {
      playerUid,
      hasPendingGift,
      giftId: giftId || null,
      status: status || null,
    });
    return true;
  } catch (error) {
    console.error('[FREEPLAY_PENDING_CACHE] mirror failed', { playerUid, error });
    return false;
  }
}

export async function tombstoneFreeplayPendingGiftCache(
  playerUid: string,
  source = 'appbeg'
): Promise<boolean> {
  const db = getPlayerMirrorPool();
  const cleanPlayerUid = cleanText(playerUid);
  if (!db || !cleanPlayerUid) {
    return false;
  }

  try {
    await db.query(
      `
        INSERT INTO public.freeplay_pending_gifts_cache (
          player_uid, has_pending_gift, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES ($1, false, $2, now(), now(), '{}'::jsonb)
        ON CONFLICT (player_uid) DO UPDATE SET
          has_pending_gift = false,
          gift_id = NULL,
          status = NULL,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = now()
      `,
      [cleanPlayerUid, source]
    );
    console.info('[FREEPLAY_PENDING_CACHE] tombstone ok', { playerUid: cleanPlayerUid });
    return true;
  } catch (error) {
    console.error('[FREEPLAY_PENDING_CACHE] tombstone failed', {
      playerUid: cleanPlayerUid,
      error,
    });
    return false;
  }
}

export async function mirrorFreeplayPendingGiftSnapshot(
  snap: DocumentSnapshot,
  source = 'appbeg'
): Promise<boolean> {
  const playerUid = cleanText(snap.id);
  if (!playerUid) {
    return false;
  }
  if (!snap.exists) {
    return tombstoneFreeplayPendingGiftCache(playerUid, source);
  }
  return upsertFreeplayPendingGiftCache(
    cacheInputFromFirestore(playerUid, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorFreeplayPendingGiftByPlayerUid(
  playerUid: string,
  source = 'appbeg'
): Promise<boolean> {
  const cleanPlayerUid = cleanText(playerUid);
  if (!cleanPlayerUid) {
    return false;
  }

  try {
    const snap = await adminDb.collection('freeplayPendingGifts').doc(cleanPlayerUid).get();
    return mirrorFreeplayPendingGiftSnapshot(snap, source);
  } catch (error) {
    console.error('[FREEPLAY_PENDING_CACHE] mirror failed', {
      playerUid: cleanPlayerUid,
      error,
    });
    return false;
  }
}

const FREEPLAY_PENDING_GIFT_BY_PLAYER_SQL = `
  SELECT
    player_uid,
    coadmin_uid,
    gift_id,
    has_pending_gift,
    status,
    amount,
    created_at,
    updated_at,
    claimed_at
  FROM public.freeplay_pending_gifts_cache
  WHERE player_uid = $1
    AND deleted_at IS NULL
  LIMIT 1
`;

export async function readFreeplayPendingGiftCacheWithClient(
  client: PoolClient,
  playerUid: string
): Promise<FreeplayPendingGiftCacheLookup> {
  const cleanPlayerUid = cleanText(playerUid);
  if (!cleanPlayerUid) {
    return { missReason: 'postgres_unavailable', row: null };
  }

  try {
    const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
      client,
      FREEPLAY_PENDING_GIFT_BY_PLAYER_SQL,
      [cleanPlayerUid]
    );
    if (!rows.length) {
      return { missReason: 'row_missing', row: null };
    }
    return { missReason: null, row: mapCacheRow(rows[0]) };
  } catch (error) {
    console.warn('[FREEPLAY_PENDING_CACHE] postgres read failed', {
      playerUid: cleanPlayerUid,
      error,
    });
    return { missReason: 'postgres_unavailable', row: null };
  }
}

export async function readFreeplayPendingGiftCache(
  playerUid: string
): Promise<FreeplayPendingGiftCacheLookup> {
  const cleanPlayerUid = cleanText(playerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanPlayerUid) {
    return { missReason: 'postgres_unavailable', row: null };
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      FREEPLAY_PENDING_GIFT_BY_PLAYER_SQL,
      [cleanPlayerUid]
    );
    if (!rows.length) {
      return { missReason: 'row_missing', row: null };
    }
    return { missReason: null, row: mapCacheRow(rows[0]) };
  } catch (error) {
    console.warn('[FREEPLAY_PENDING_CACHE] postgres read failed', {
      playerUid: cleanPlayerUid,
      error,
    });
    return { missReason: 'postgres_unavailable', row: null };
  }
}
