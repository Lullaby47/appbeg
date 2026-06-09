import 'server-only';

import type { PoolClient } from 'pg';

import {
  buildUniqueReferralCodeCandidates,
  isValidReferralCodeString,
} from '@/lib/referral/referralCodeAdmin';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export { buildUniqueReferralCodeCandidates, isValidReferralCodeString };

export async function findFreeReferralCodeInTxn(
  client: PoolClient,
  candidates: string[],
  playerUidToIgnore?: string
): Promise<string | null> {
  for (const code of candidates) {
    const cleanCode = cleanText(code);
    if (!isValidReferralCodeString(cleanCode)) continue;

    const indexResult = await client.query(
      `
        SELECT code, player_uid
        FROM public.referral_codes_cache
        WHERE code = $1
        FOR UPDATE
      `,
      [cleanCode]
    );
    const indexHolder = cleanText((indexResult.rows[0] as { player_uid?: string })?.player_uid);
    if (indexHolder && indexHolder !== cleanText(playerUidToIgnore)) {
      continue;
    }

    const usersResult = await client.query(
      `
        SELECT uid
        FROM public.players_cache
        WHERE referral_code = $1
          AND deleted_at IS NULL
        LIMIT 2
      `,
      [cleanCode]
    );
    if (usersResult.rows.length > 1) continue;
    if (
      usersResult.rows.length === 1 &&
      cleanText((usersResult.rows[0] as { uid?: string }).uid) !== cleanText(playerUidToIgnore)
    ) {
      continue;
    }
    return cleanCode;
  }
  return null;
}

export async function upsertReferralCodeInTxn(
  client: PoolClient,
  code: string,
  playerUid: string,
  nowIso: string,
  source = 'authority'
) {
  const raw = { playerUid, code, createdAt: nowIso };
  await client.query(
    `
      INSERT INTO public.referral_codes_cache (
        code, player_uid, created_at, raw_firestore_data, source, mirrored_at, deleted_at
      )
      VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5, now(), NULL)
      ON CONFLICT (code) DO UPDATE SET
        player_uid = EXCLUDED.player_uid,
        created_at = COALESCE(public.referral_codes_cache.created_at, EXCLUDED.created_at),
        raw_firestore_data = EXCLUDED.raw_firestore_data,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL
    `,
    [code, playerUid, nowIso, JSON.stringify(raw), source]
  );
}

export async function tombstoneReferralCodeInTxn(
  client: PoolClient,
  code: string,
  source = 'authority'
) {
  await client.query(
    `
      INSERT INTO public.referral_codes_cache (code, raw_firestore_data, source, mirrored_at, deleted_at)
      VALUES ($1, '{}'::jsonb, $2, now(), now())
      ON CONFLICT (code) DO UPDATE SET source = EXCLUDED.source, mirrored_at = now(), deleted_at = now()
    `,
    [code, source]
  );
}

export async function lookupReferrerByCodeFromSql(referralCode: string) {
  const db = getPlayerMirrorPool();
  const code = cleanText(referralCode);
  if (!db || !code) return null;

  const fromPlayers = await db.query(
    `
      SELECT uid, username, role
      FROM public.players_cache
      WHERE referral_code = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [code]
  );
  if (fromPlayers.rows.length) {
    const row = fromPlayers.rows[0] as { uid?: string; username?: string; role?: string };
    if (cleanText(row.role).toLowerCase() === 'player') {
      return { uid: cleanText(row.uid), username: cleanText(row.username) || 'Player' };
    }
  }

  const fromIndex = await db.query(
    `
      SELECT r.player_uid, p.username, p.role
      FROM public.referral_codes_cache r
      LEFT JOIN public.players_cache p ON p.uid = r.player_uid AND p.deleted_at IS NULL
      WHERE r.code = $1
        AND r.deleted_at IS NULL
      LIMIT 1
    `,
    [code]
  );
  if (!fromIndex.rows.length) return null;
  const row = fromIndex.rows[0] as { player_uid?: string; username?: string; role?: string };
  if (cleanText(row.role).toLowerCase() !== 'player') return null;
  return {
    uid: cleanText(row.player_uid),
    username: cleanText(row.username) || 'Player',
  };
}

export async function lookupReferrerByCodeInTxn(client: PoolClient, referralCode: string) {
  const code = cleanText(referralCode);
  if (!code) return null;

  const fromPlayers = await client.query(
    `
      SELECT uid, username, role
      FROM public.players_cache
      WHERE referral_code = $1
        AND deleted_at IS NULL
      FOR UPDATE
      LIMIT 1
    `,
    [code]
  );
  if (fromPlayers.rows.length) {
    const row = fromPlayers.rows[0] as { uid?: string; username?: string; role?: string };
    if (cleanText(row.role).toLowerCase() === 'player') {
      return {
        uid: cleanText(row.uid),
        username: cleanText(row.username) || 'Player',
      };
    }
  }

  const fromIndex = await client.query(
    `
      SELECT r.player_uid, p.username, p.role
      FROM public.referral_codes_cache r
      LEFT JOIN public.players_cache p ON p.uid = r.player_uid AND p.deleted_at IS NULL
      WHERE r.code = $1
        AND r.deleted_at IS NULL
      FOR UPDATE OF r
      LIMIT 1
    `,
    [code]
  );
  if (!fromIndex.rows.length) return null;
  const row = fromIndex.rows[0] as { player_uid?: string; username?: string; role?: string };
  if (cleanText(row.role).toLowerCase() !== 'player') return null;
  return {
    uid: cleanText(row.player_uid),
    username: cleanText(row.username) || 'Player',
  };
}

export async function isReferralCodeOwnedByPlayerInTxn(
  client: PoolClient,
  code: string,
  playerUid: string
) {
  const cleanCode = cleanText(code);
  const cleanUid = cleanText(playerUid);
  if (!isValidReferralCodeString(cleanCode) || !cleanUid) return false;

  const players = await client.query(
    `
      SELECT uid
      FROM public.players_cache
      WHERE referral_code = $1
        AND deleted_at IS NULL
      LIMIT 2
    `,
    [cleanCode]
  );
  if (players.rows.length === 1 && cleanText((players.rows[0] as { uid?: string }).uid) === cleanUid) {
    return true;
  }
  if (players.rows.length > 1) return false;

  const index = await client.query(
    `
      SELECT player_uid
      FROM public.referral_codes_cache
      WHERE code = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [cleanCode]
  );
  if (!index.rows.length) return true;
  const holder = cleanText((index.rows[0] as { player_uid?: string }).player_uid);
  return !holder || holder === cleanUid;
}

export async function upsertReferralLogInTxn(
  client: PoolClient,
  referralId: string,
  input: Record<string, unknown>,
  source = 'authority'
) {
  const nowIso = toIsoString(input.createdAt) || new Date().toISOString();
  const raw = { ...input, createdAt: nowIso };
  await client.query(
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
      referralId,
      cleanText(input.referrerUid),
      cleanText(input.referrerUsername),
      cleanText(input.referredPlayerUid),
      cleanText(input.referredPlayerUsername),
      cleanText(input.referralCode),
      input.rewardCoins == null ? null : Number(input.rewardCoins),
      cleanText(input.status),
      nowIso,
      toIsoString(input.qualifiedAt),
      toIsoString(input.claimedAt),
      JSON.stringify(raw),
      source,
    ]
  );
}
