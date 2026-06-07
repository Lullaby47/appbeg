import 'server-only';

import type { PoolClient } from 'pg';
import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  numberOrNull,
  runMirrorClientQuery,
  runMirrorPoolQuery,
  type PlayerMirrorSqlTiming,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export async function mirrorPlayerCache(uid: string, data: Record<string, unknown>, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) return false;
  try {
    await db.query(
      `
        INSERT INTO public.players_cache (
          uid, username, email, role, status, created_by, coadmin_uid, created_by_staff_id,
          coin, cash, promo_locked_coins, referral_code, referred_by_uid, referred_by_code,
          referral_bonus_coins, referral_created_at, referral_reward_status,
          referral_qualified_at, referral_reward_claimed_at, password_updated_at,
          password_updated_by_uid, password_updated_by_role, transferred_by_uid,
          created_at, updated_at, restored_at, raw_firestore_data, source, mirrored_at, deleted_at
        )
        VALUES (
          $1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
          NULLIF($8, ''), $9, $10, $11, NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''),
          $15, $16::timestamptz, NULLIF($17, ''), $18::timestamptz, $19::timestamptz,
          $20::timestamptz, NULLIF($21, ''), NULLIF($22, ''), NULLIF($23, ''),
          $24::timestamptz, $25::timestamptz, $26::timestamptz, $27::jsonb, $28, now(), NULL
        )
        ON CONFLICT (uid) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          created_by = EXCLUDED.created_by,
          coadmin_uid = EXCLUDED.coadmin_uid,
          created_by_staff_id = EXCLUDED.created_by_staff_id,
          coin = EXCLUDED.coin,
          cash = EXCLUDED.cash,
          promo_locked_coins = EXCLUDED.promo_locked_coins,
          referral_code = EXCLUDED.referral_code,
          referred_by_uid = EXCLUDED.referred_by_uid,
          referred_by_code = EXCLUDED.referred_by_code,
          referral_bonus_coins = EXCLUDED.referral_bonus_coins,
          referral_created_at = EXCLUDED.referral_created_at,
          referral_reward_status = EXCLUDED.referral_reward_status,
          referral_qualified_at = EXCLUDED.referral_qualified_at,
          referral_reward_claimed_at = EXCLUDED.referral_reward_claimed_at,
          password_updated_at = EXCLUDED.password_updated_at,
          password_updated_by_uid = EXCLUDED.password_updated_by_uid,
          password_updated_by_role = EXCLUDED.password_updated_by_role,
          transferred_by_uid = EXCLUDED.transferred_by_uid,
          created_at = COALESCE(public.players_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          restored_at = EXCLUDED.restored_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        cleanUid,
        cleanText(data.username),
        cleanText(data.email),
        cleanText(data.role) || 'player',
        cleanText(data.status),
        cleanText(data.createdBy),
        cleanText(data.coadminUid),
        cleanText(data.createdByStaffId),
        numberOrNull(data.coin),
        numberOrNull(data.cash),
        numberOrNull(data.promoLockedCoins),
        cleanText(data.referralCode),
        cleanText(data.referredByUid),
        cleanText(data.referredByCode),
        numberOrNull(data.referralBonusCoins),
        toIsoString(data.referralCreatedAt),
        cleanText(data.referralRewardStatus),
        toIsoString(data.referralQualifiedAt),
        toIsoString(data.referralRewardClaimedAt),
        toIsoString(data.passwordUpdatedAt),
        cleanText(data.passwordUpdatedByUid),
        cleanText(data.passwordUpdatedByRole),
        cleanText(data.transferredByUid),
        toIsoString(data.createdAt),
        toIsoString(data.updatedAt),
        toIsoString(data.restoredAt),
        JSON.stringify(normalizeJson(data) || {}),
        source,
      ]
    );
    console.info('[PLAYERS_CACHE] mirror upsert ok', { uid: cleanUid });
    return true;
  } catch (error) {
    console.error('[PLAYERS_CACHE] mirror failed', { uid: cleanUid, error });
    return false;
  }
}

export async function mirrorPlayerSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return mirrorPlayerCache(snap.id, (snap.data() || {}) as Record<string, unknown>, source);
}

export async function mirrorPlayerById(uid: string, source = 'appbeg') {
  const cleanUid = cleanText(uid);
  if (!cleanUid) return false;
  try {
    return mirrorPlayerSnapshot(await adminDb.collection('users').doc(cleanUid).get(), source);
  } catch (error) {
    console.error('[PLAYERS_CACHE] mirror failed', { uid: cleanUid, error });
    return false;
  }
}

export async function tombstonePlayerCache(uid: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) return false;
  try {
    await db.query(
      `
        INSERT INTO public.players_cache (uid, username, role, raw_firestore_data, source, mirrored_at, deleted_at)
        VALUES ($1, $1, 'player', '{}'::jsonb, $2, now(), now())
        ON CONFLICT (uid) DO UPDATE SET
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = now()
      `,
      [cleanUid, source]
    );
    console.info('[PLAYERS_CACHE] tombstone ok', { uid: cleanUid });
    return true;
  } catch (error) {
    console.error('[PLAYERS_CACHE] tombstone failed', { uid: cleanUid, error });
    return false;
  }
}

export type CarerSqlProfileLookup = {
  role: string;
  coadminUid: string | null;
};

export type CarerSqlProfileLookupResult = {
  profile: CarerSqlProfileLookup | null;
  /** @deprecated Use timing.total_ms */
  queryMs: number;
  timing: PlayerMirrorSqlTiming;
  missReason: 'row_missing' | 'role_mismatch' | 'postgres_unavailable' | 'lookup_failed' | null;
};

export async function lookupCarerProfileFromSqlCache(
  carerUid: string,
  mirrorClient?: PoolClient
): Promise<CarerSqlProfileLookupResult> {
  const startedAt = Date.now();
  const cleanUid = cleanText(carerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanUid) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info(
      '[LIVE_AUTH_SQL_PROFILE] miss reason=%s uid=%s durationMs=%s pool_acquire_ms=%s query_exec_ms=%s',
      'postgres_unavailable',
      cleanUid || null,
      timing.total_ms,
      timing.pool_acquire_ms,
      timing.query_exec_ms
    );
    return {
      profile: null,
      queryMs: 0,
      timing,
      missReason: 'postgres_unavailable',
    };
  }

  const profileSql = `
    SELECT role, coadmin_uid, created_by
    FROM public.players_cache
    WHERE uid = $1
      AND deleted_at IS NULL
    LIMIT 1
  `;

  try {
    const { rows, timing } = mirrorClient
      ? await runMirrorClientQuery<Record<string, unknown>>(mirrorClient, profileSql, [cleanUid])
      : await runMirrorPoolQuery<Record<string, unknown>>(db, profileSql, [cleanUid]);

    if (!rows.length) {
      console.info(
        '[LIVE_AUTH_SQL_PROFILE] miss reason=%s uid=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
        'row_missing',
        cleanUid,
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms
      );
      return { profile: null, queryMs: timing.total_ms, timing, missReason: 'row_missing' };
    }

    const row = rows[0];
    const profile = {
      role: cleanText(row.role).toLowerCase(),
      coadminUid:
        cleanText(row.coadmin_uid) || cleanText(row.created_by) || null,
    } satisfies CarerSqlProfileLookup;

    if (profile.role !== 'carer') {
      console.info(
        '[LIVE_AUTH_SQL_PROFILE] miss reason=%s uid=%s role=%s coadminUid=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s',
        'role_mismatch',
        cleanUid,
        profile.role || null,
        profile.coadminUid,
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms
      );
      return { profile, queryMs: timing.total_ms, timing, missReason: 'role_mismatch' };
    }

    console.info(
      '[LIVE_AUTH_SQL_PROFILE] hit=true uid=%s role=%s coadminUid=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s shared_client=%s',
      cleanUid,
      profile.role,
      profile.coadminUid,
      timing.pool_acquire_ms,
      timing.query_exec_ms,
      timing.total_ms,
      Boolean(mirrorClient)
    );
    return { profile, queryMs: timing.total_ms, timing, missReason: null };
  } catch (error) {
    const timing = {
      pool_acquire_ms: 0,
      query_exec_ms: 0,
      total_ms: Date.now() - startedAt,
    };
    console.info(
      '[LIVE_AUTH_SQL_PROFILE] miss reason=%s uid=%s total_ms=%s error=%s',
      'lookup_failed',
      cleanUid,
      timing.total_ms,
      error instanceof Error ? error.message : String(error)
    );
    return {
      profile: null,
      queryMs: timing.total_ms,
      timing,
      missReason: 'lookup_failed',
    };
  }
}
