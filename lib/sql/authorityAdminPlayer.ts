import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { REFERRAL_REWARD_COINS } from '@/lib/economy/policy';
import { hashPassword } from '@/lib/auth/passwordHash';
import {
  buildUniqueReferralCodeCandidates,
  findFreeReferralCodeInTxn,
  isReferralCodeOwnedByPlayerInTxn,
  isValidReferralCodeString,
  lookupReferrerByCodeInTxn,
  tombstoneReferralCodeInTxn,
  upsertReferralCodeInTxn,
  upsertReferralLogInTxn,
} from '@/lib/sql/authorityReferralCodes';
import { insertAuthorityLedgerEvent } from '@/lib/sql/authorityLedger';
import { normalizeGameName } from '@/lib/sql/authorityGameRequestHelpers';
import { lookupUserDirectoryFromSql } from '@/lib/sql/authorityLookup';
import {
  coadminTaskLiveChannel,
  insertLiveOutboxEventWithClient,
} from '@/lib/sql/liveOutbox';
import { scheduleAutoClaimPendingTaskOnCreate } from '@/lib/sql/authorityAutoClaim';
import { readGameLoginsCacheByCoadminWithClient } from '@/lib/sql/gameLoginsCache';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';
import { updatePlayerBalancesInTxn } from '@/lib/sql/authorityGameRequestHelpers';

type GameLoginSeed = {
  id: string;
  gameName: string;
  username?: string | null;
  password?: string | null;
  backendUrl?: string | null;
  frontendUrl?: string | null;
  siteUrl?: string | null;
};

function createGameUsernameTaskId(coadminUid: string, playerUid: string, gameName: string) {
  return `create_game_username__${coadminUid}__${playerUid}__${normalizeGameName(gameName)}`;
}

function normalizeTaskUrl(value?: unknown) {
  const trimmed = cleanText(value);
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function resolveTaskGameAccess(game: GameLoginSeed) {
  const loginUrl = normalizeTaskUrl(game.backendUrl || game.siteUrl);
  const siteUrl = normalizeTaskUrl(game.siteUrl || game.frontendUrl || game.backendUrl);
  return {
    loginUrl,
    gameLoginUrl: loginUrl,
    lobbyUrl: loginUrl,
    siteUrl,
    baseUrl: loginUrl || siteUrl,
    gameCredentialUsername: cleanText(game.username) || null,
    gameCredentialPassword: cleanText(game.password) || null,
  };
}

async function upsertCreateUsernameTaskInTxn(
  client: PoolClient,
  input: {
    taskId: string;
    coadminUid: string;
    playerUid: string;
    playerUsername: string;
    playerPassword: string;
    game: GameLoginSeed;
    nowIso: string;
  }
) {
  const access = resolveTaskGameAccess(input.game);
  const raw = {
    coadminUid: input.coadminUid,
    coadminId: input.coadminUid,
    type: 'create_game_username',
    action: 'createUsername',
    taskAction: 'createUsername',
    playerUid: input.playerUid,
    playerId: input.playerUid,
    playerUsername: input.playerUsername,
    username: input.playerUsername,
    password: input.playerPassword,
    gameName: input.game.gameName,
    game: input.game.gameName,
    amount: null,
    requestId: null,
    status: 'pending',
    retryPending: false,
    pendingSince: input.nowIso,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    isPoked: false,
    playerLoginUsername: input.playerUsername,
    playerLoginPassword: input.playerPassword,
    ...access,
  };
  await client.query(
    `
      INSERT INTO public.carer_tasks_cache (
        firebase_id, coadmin_uid, type, player_uid, player_username, game_name,
        normalized_game_name, amount, request_id, status, login_url, game_login_url,
        lobby_url, site_url, base_url, game_credential_username, game_credential_password,
        retry_pending, created_at, updated_at, pending_since, source, mirrored_at,
        deleted_at, raw_firestore_data
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, NULL, NULL, 'pending',
        NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''),
        NULLIF($13, ''), NULLIF($14, ''), FALSE,
        $15::timestamptz, $15::timestamptz, $15::timestamptz, 'authority_create_player', now(), NULL,
        $16::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        status = EXCLUDED.status,
        retry_pending = FALSE,
        returned_to_pending_at = NULL,
        updated_at = EXCLUDED.updated_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      input.taskId,
      input.coadminUid,
      'create_game_username',
      input.playerUid,
      input.playerUsername,
      input.game.gameName,
      normalizeGameName(input.game.gameName),
      access.loginUrl,
      access.gameLoginUrl,
      access.lobbyUrl,
      access.siteUrl,
      access.baseUrl,
      access.gameCredentialUsername,
      access.gameCredentialPassword,
      input.nowIso,
      JSON.stringify(raw),
    ]
  );
  console.info('[CREATE_USERNAME_RETRY_PENDING_DEFAULTED_FALSE]', {
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    playerUid: input.playerUid,
    gameName: input.game.gameName,
  });
  await insertLiveOutboxEventWithClient(client, {
    channel: coadminTaskLiveChannel(input.coadminUid),
    eventType: 'task.created',
    entityType: 'carer_task',
    entityId: input.taskId,
    source: 'authority_create_player',
    mirroredAt: input.nowIso,
    payload: {
      entityId: input.taskId,
      taskId: input.taskId,
      coadminUid: input.coadminUid,
      status: 'pending',
      type: 'create_game_username',
      gameName: input.game.gameName,
      updatedAt: input.nowIso,
      source: 'authority',
    },
  });
}

async function loadGameLoginSeedsInTxn(client: PoolClient, coadminUid: string): Promise<GameLoginSeed[]> {
  const rows = await readGameLoginsCacheByCoadminWithClient(client, coadminUid);
  const byGame = new Map<string, GameLoginSeed>();
  for (const row of rows || []) {
    const gameName = cleanText(row.gameName);
    const normalized = normalizeGameName(gameName);
    if (!gameName || !normalized || byGame.has(normalized)) continue;
    byGame.set(normalized, {
      id: cleanText(row.id),
      gameName,
      username: row.username,
      password: row.password,
      backendUrl: row.backendUrl,
      frontendUrl: row.frontendUrl,
      siteUrl: row.siteUrl,
    });
  }
  return Array.from(byGame.values());
}

export type CreatePlayerInSqlInput = {
  uid: string;
  username: string;
  email: string;
  password: string;
  ownerCoadminUid: string;
  createdByStaffId?: string | null;
  referralCodeInput?: string | null;
  actorUid: string;
  actorRole: string;
};

export type CreatePlayerInSqlResult = {
  success: true;
  uid: string;
  referralCode: string;
  referralApplied: boolean;
  referralBonusCoins: number;
  referredByUid: string | null;
  referredByUsername: string | null;
  createdTaskIds: string[];
  referralId: string | null;
};

export async function createPlayerInSql(input: CreatePlayerInSqlInput): Promise<CreatePlayerInSqlResult> {
  const uid = cleanText(input.uid);
  const username = cleanText(input.username);
  const email = cleanText(input.email);
  const ownerCoadminUid = cleanText(input.ownerCoadminUid);
  if (!uid || !username || !email || !ownerCoadminUid) {
    throw new Error('uid, username, email, and ownerCoadminUid are required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');

  const hashed = await hashPassword(input.password);
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT uid FROM public.players_cache WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [username]
    );
    if (existing.rows.length) {
      throw new Error('Username already exists.');
    }

    let referredByUid: string | null = null;
    let referredByUsername: string | null = null;
    let referredByCode: string | null = null;
    let referralApplied = false;
    let referralBonusCoins = 0;
    let referralId: string | null = null;

    const referralCodeInput = cleanText(input.referralCodeInput);
    if (referralCodeInput) {
      const referrer = await lookupReferrerByCodeInTxn(client, referralCodeInput);
      if (!referrer?.uid) {
        throw new Error('Invalid referral code.');
      }
      if (referrer.uid === uid) {
        throw new Error('A player cannot refer themselves.');
      }
      referredByUid = referrer.uid;
      referredByUsername = referrer.username;
      referredByCode = referralCodeInput;
      referralApplied = true;
      referralBonusCoins = REFERRAL_REWARD_COINS;
    }

    const nextReferralCode = await findFreeReferralCodeInTxn(
      client,
      buildUniqueReferralCodeCandidates(40)
    );
    if (!nextReferralCode) {
      throw new Error('Failed to generate a unique referral code. Please try again.');
    }

    const rawPlayer = {
      uid,
      username,
      email,
      role: 'player',
      createdBy: ownerCoadminUid,
      coadminUid: ownerCoadminUid,
      createdAt: nowIso,
      status: 'active',
      coin: 0,
      cash: 0,
      promoLockedCoins: 0,
      referralCode: nextReferralCode,
      referredByUid,
      referredByCode,
      referralBonusCoins: referralApplied ? referralBonusCoins : 0,
      referralCreatedAt: referralApplied ? nowIso : null,
      referralRewardStatus: referralApplied ? 'pending_first_recharge' : null,
      referralQualifiedAt: null,
      referralRewardClaimedAt: null,
      createdByStaffId: cleanText(input.createdByStaffId) || null,
    };

    await client.query(
      `
        INSERT INTO public.players_cache (
          uid, username, email, role, status, created_by, coadmin_uid, created_by_staff_id,
          coin, cash, promo_locked_coins, referral_code, referred_by_uid, referred_by_code,
          referral_bonus_coins, referral_created_at, referral_reward_status,
          created_at, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
        )
        VALUES (
          $1, $2, $3, 'player', 'active', $4, $4, NULLIF($5, ''),
          0, 0, 0, $6, NULLIF($7, ''), NULLIF($8, ''), $9,
          $10::timestamptz, NULLIF($11, ''),
          $12::timestamptz, $12::timestamptz, $13::jsonb, 'authority_create_player', now(), NULL
        )
      `,
      [
        uid,
        username,
        email,
        ownerCoadminUid,
        cleanText(input.createdByStaffId),
        nextReferralCode,
        referredByUid,
        referredByCode,
        referralApplied ? referralBonusCoins : 0,
        referralApplied ? nowIso : null,
        referralApplied ? 'pending_first_recharge' : null,
        nowIso,
        JSON.stringify(rawPlayer),
      ]
    );

    await client.query(
      `
        INSERT INTO public.user_credentials (
          uid, password_hash, password_algo, password_updated_at,
          migrated_from_firebase, must_reset, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4::timestamptz, FALSE, FALSE, $4::timestamptz, $4::timestamptz)
        ON CONFLICT (uid) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          password_algo = EXCLUDED.password_algo,
          password_updated_at = EXCLUDED.password_updated_at,
          updated_at = EXCLUDED.updated_at
      `,
      [uid, hashed.hash, hashed.algo, nowIso]
    );

    await client.query(
      `
        INSERT INTO public.user_balance_snapshots_cache (
          firebase_id, username, email, role, status, coadmin_uid, created_by,
          coin, cash, promo_locked_coins, created_at, updated_at, source, mirrored_at,
          deleted_at, raw_firestore_data
        )
        VALUES (
          $1, $2, $3, 'player', 'active', $4, $4, 0, 0, 0,
          $5::timestamptz, $5::timestamptz, 'authority_create_player', now(), NULL, $6::jsonb
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
          promo_locked_coins = EXCLUDED.promo_locked_coins,
          updated_at = EXCLUDED.updated_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [uid, username, email, ownerCoadminUid, nowIso, JSON.stringify(rawPlayer)]
    );

    await upsertReferralCodeInTxn(client, nextReferralCode, uid, nowIso, 'authority_create_player');

    if (referralApplied && referredByUid) {
      referralId = randomUUID();
      await upsertReferralLogInTxn(
        client,
        referralId,
        {
          referrerUid: referredByUid,
          referrerUsername: referredByUsername,
          referredPlayerUid: uid,
          referredPlayerUsername: username,
          referralCode: referralCodeInput,
          rewardCoins: referralBonusCoins,
          status: 'pending_first_recharge',
          createdAt: nowIso,
          qualifiedAt: null,
          claimedAt: null,
        },
        'authority_create_player'
      );
    }

    const games = await loadGameLoginSeedsInTxn(client, ownerCoadminUid);
    const createdTaskIds: string[] = [];
    for (const game of games) {
      const taskId = createGameUsernameTaskId(ownerCoadminUid, uid, game.gameName);
      console.info('[CREATE_USERNAME_TASK_CREATE_START]', {
        taskId,
        coadminUid: ownerCoadminUid,
        playerUid: uid,
        gameName: game.gameName,
      });
      await upsertCreateUsernameTaskInTxn(client, {
        taskId,
        coadminUid: ownerCoadminUid,
        playerUid: uid,
        playerUsername: username,
        playerPassword: input.password,
        game,
        nowIso,
      });
      createdTaskIds.push(taskId);
      console.info('[CREATE_USERNAME_TASK_CREATED]', {
        taskId,
        coadminUid: ownerCoadminUid,
        playerUid: uid,
        gameName: game.gameName,
        status: 'pending',
        retryPending: false,
      });
    }

    await client.query('COMMIT');
    for (const taskId of createdTaskIds) {
      scheduleAutoClaimPendingTaskOnCreate({
        taskId,
        coadminUid: ownerCoadminUid,
        trigger: 'authority_create_player',
      });
    }
    return {
      success: true,
      uid,
      referralCode: nextReferralCode,
      referralApplied,
      referralBonusCoins,
      referredByUid,
      referredByUsername,
      createdTaskIds,
      referralId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function transferPlayerCoadminInSql(input: {
  playerUid: string;
  targetCoadminUid: string;
  actorUid: string;
}) {
  const playerUid = cleanText(input.playerUid);
  const targetCoadminUid = cleanText(input.targetCoadminUid);
  const actorUid = cleanText(input.actorUid);
  if (!playerUid || !targetCoadminUid) {
    throw new Error('playerUid and targetCoadminUid are required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const playerLock = await client.query(
      `SELECT * FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL FOR UPDATE`,
      [playerUid]
    );
    if (!playerLock.rows.length) throw new Error('Player not found.');
    const player = playerLock.rows[0] as Record<string, unknown>;
    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error('Target user is not a player.');
    }

    const coadmin = await lookupUserDirectoryFromSql(targetCoadminUid, client);
    if (!coadmin || cleanText(coadmin.role).toLowerCase() !== 'coadmin') {
      throw new Error('Target coadmin is invalid.');
    }

    const rawPatch = {
      coadminUid: targetCoadminUid,
      createdBy: targetCoadminUid,
      transferredByUid: actorUid,
      updatedAt: nowIso,
    };

    await client.query(
      `
        UPDATE public.players_cache
        SET
          coadmin_uid = $2,
          created_by = $2,
          transferred_by_uid = $3,
          updated_at = $4::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $5::jsonb,
          source = 'authority_transfer_player',
          mirrored_at = now()
        WHERE uid = $1 AND deleted_at IS NULL
      `,
      [playerUid, targetCoadminUid, actorUid, nowIso, JSON.stringify(rawPatch)]
    );

    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          coadmin_uid = $2,
          created_by = $2,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $4::jsonb,
          source = 'authority_transfer_player'
        WHERE firebase_id = $1 AND deleted_at IS NULL
      `,
      [playerUid, targetCoadminUid, nowIso, JSON.stringify(rawPatch)]
    );

    await client.query('COMMIT');
    return { success: true as const, playerUid, targetCoadminUid };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function lookupDeletedPlayerFromSql(uid: string) {
  const cleanUid = cleanText(uid);
  if (!cleanUid) return null;
  const db = getPlayerMirrorPool();
  if (!db) return null;
  const result = await db.query(
    `
      SELECT uid, username, email
      FROM public.deleted_players_cache
      WHERE uid = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [cleanUid]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0] as Record<string, unknown>;
  return {
    uid: cleanText(row.uid),
    username: cleanText(row.username),
    email: cleanText(row.email),
  };
}

export async function listDeletedPlayersFromSql() {
  const db = getPlayerMirrorPool();
  if (!db) return [];
  const result = await db.query(
    `
      SELECT uid, username, email, role, status, created_by, coadmin_uid, coin, cash,
             referral_code, referred_by_uid, referred_by_code, referral_bonus_coins,
             referral_created_at, deleted_at_source, deleted_by_uid
      FROM public.deleted_players_cache
      WHERE deleted_at IS NULL
        AND role = 'player'
      ORDER BY deleted_at_source DESC NULLS LAST
    `
  );
  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      uid: cleanText(r.uid),
      username: cleanText(r.username),
      email: cleanText(r.email),
      role: 'player' as const,
      status: cleanText(r.status) || 'active',
      createdBy: cleanText(r.created_by) || null,
      coadminUid: cleanText(r.coadmin_uid) || null,
      coin: Number(r.coin || 0),
      cash: Number(r.cash || 0),
      referralCode: cleanText(r.referral_code) || null,
      referredByUid: cleanText(r.referred_by_uid) || null,
      referredByCode: cleanText(r.referred_by_code) || null,
      referralBonusCoins: Number(r.referral_bonus_coins || 0),
      referralCreatedAt: toIsoString(r.referral_created_at),
      deletedAt: toIsoString(r.deleted_at_source),
      deletedByUid: cleanText(r.deleted_by_uid) || null,
    };
  });
}

export async function restorePlayerFromArchiveInSql(input: {
  uid: string;
  password: string;
  defaultPassword: string;
}) {
  const uid = cleanText(input.uid);
  if (!uid) throw new Error('Player uid is required.');

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const archived = await client.query(
      `SELECT * FROM public.deleted_players_cache WHERE uid = $1 AND deleted_at IS NULL FOR UPDATE`,
      [uid]
    );
    if (!archived.rows.length) throw new Error('Deleted player not found.');
    const deleted = archived.rows[0] as Record<string, unknown>;

    const active = await client.query(
      `SELECT uid FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL LIMIT 1`,
      [uid]
    );
    if (active.rows.length) throw new Error('Player already active.');

    const username = cleanText(deleted.username);
    const email = cleanText(deleted.email) || `${username}@app.local`;
    if (!username) throw new Error('Deleted player username is invalid.');

    const archivedReferralCode = cleanText(deleted.referral_code);
    let referralCode = '';
    if (
      isValidReferralCodeString(archivedReferralCode) &&
      (await isReferralCodeOwnedByPlayerInTxn(client, archivedReferralCode, uid))
    ) {
      referralCode = archivedReferralCode;
    } else {
      const free = await findFreeReferralCodeInTxn(client, buildUniqueReferralCodeCandidates(40), uid);
      if (!free) throw new Error('Failed to assign a unique referral code.');
      referralCode = free;
    }

    const rawPlayer = {
      uid,
      username,
      email,
      role: 'player',
      status: cleanText(deleted.status) || 'active',
      createdBy: cleanText(deleted.created_by),
      coadminUid: cleanText(deleted.coadmin_uid),
      coin: Number(deleted.coin || 0),
      cash: Number(deleted.cash || 0),
      referralCode,
      referredByUid: cleanText(deleted.referred_by_uid),
      referredByCode: cleanText(deleted.referred_by_code),
      referralBonusCoins: Number(deleted.referral_bonus_coins || 0),
      referralCreatedAt: toIsoString(deleted.referral_created_at),
      createdAt: nowIso,
      restoredAt: nowIso,
    };

    const hashed = await hashPassword(input.password || input.defaultPassword);

    await client.query(
      `
        INSERT INTO public.players_cache (
          uid, username, email, role, status, created_by, coadmin_uid,
          coin, cash, referral_code, referred_by_uid, referred_by_code,
          referral_bonus_coins, referral_created_at, restored_at,
          created_at, updated_at, raw_firestore_data, source, mirrored_at, deleted_at
        )
        VALUES (
          $1, $2, $3, 'player', $4, NULLIF($5, ''), NULLIF($6, ''),
          $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''), $12,
          $13::timestamptz, $14::timestamptz, $14::timestamptz, $14::timestamptz,
          $15::jsonb, 'authority_player_restore', now(), NULL
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
          restored_at = EXCLUDED.restored_at,
          updated_at = EXCLUDED.updated_at,
          deleted_at = NULL,
          source = EXCLUDED.source,
          mirrored_at = now(),
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        uid,
        username,
        email,
        cleanText(deleted.status) || 'active',
        cleanText(deleted.created_by),
        cleanText(deleted.coadmin_uid),
        Number(deleted.coin || 0),
        Number(deleted.cash || 0),
        referralCode,
        cleanText(deleted.referred_by_uid),
        cleanText(deleted.referred_by_code),
        Number(deleted.referral_bonus_coins || 0),
        toIsoString(deleted.referral_created_at),
        nowIso,
        JSON.stringify(rawPlayer),
      ]
    );

    await client.query(
      `
        INSERT INTO public.user_credentials (
          uid, password_hash, password_algo, password_updated_at,
          migrated_from_firebase, must_reset, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4::timestamptz, FALSE, FALSE, $4::timestamptz, $4::timestamptz)
        ON CONFLICT (uid) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          password_algo = EXCLUDED.password_algo,
          password_updated_at = EXCLUDED.password_updated_at,
          updated_at = EXCLUDED.updated_at
      `,
      [uid, hashed.hash, hashed.algo, nowIso]
    );

    await client.query(
      `
        INSERT INTO public.user_balance_snapshots_cache (
          firebase_id, username, email, role, status, coadmin_uid, created_by,
          coin, cash, created_at, updated_at, restored_at, source, mirrored_at,
          deleted_at, raw_firestore_data
        )
        VALUES (
          $1, $2, $3, 'player', $4, NULLIF($5, ''), NULLIF($6, ''),
          $7, $8, $9::timestamptz, $9::timestamptz, $9::timestamptz,
          'authority_player_restore', now(), NULL, $10::jsonb
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
          restored_at = EXCLUDED.restored_at,
          updated_at = EXCLUDED.updated_at,
          deleted_at = NULL,
          source = EXCLUDED.source,
          mirrored_at = now(),
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        uid,
        username,
        email,
        cleanText(deleted.status) || 'active',
        cleanText(deleted.created_by),
        cleanText(deleted.coadmin_uid),
        Number(deleted.coin || 0),
        Number(deleted.cash || 0),
        nowIso,
        JSON.stringify(rawPlayer),
      ]
    );

    await upsertReferralCodeInTxn(client, referralCode, uid, nowIso, 'authority_player_restore');

    await client.query(
      `
        UPDATE public.deleted_players_cache
        SET deleted_at = now(), mirrored_at = now(), source = 'authority_player_restore'
        WHERE uid = $1
      `,
      [uid]
    );

    await client.query('COMMIT');
    return {
      success: true as const,
      uid,
      username,
      email,
      referralCode,
      coadminUid: cleanText(deleted.coadmin_uid) || cleanText(deleted.created_by) || null,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function purgeDeletedPlayerArchiveInSql(uid: string) {
  const cleanUid = cleanText(uid);
  if (!cleanUid) throw new Error('Player uid is required.');
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  await db.query(
    `
      UPDATE public.deleted_players_cache
      SET deleted_at = now(), mirrored_at = now(), source = 'authority_player_archive_purge'
      WHERE uid = $1 AND deleted_at IS NULL
    `,
    [cleanUid]
  );
  return { success: true as const, uid: cleanUid };
}

export async function ensureReferralCodeInSql(playerUid: string) {
  const uid = cleanText(playerUid);
  if (!uid) throw new Error('playerUid is required.');

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const playerLock = await client.query(
      `SELECT uid, username, role, referral_code FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL FOR UPDATE`,
      [uid]
    );
    if (!playerLock.rows.length) throw new Error('User profile not found.');
    const player = playerLock.rows[0] as Record<string, unknown>;
    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error('Only players have referral codes.');
    }

    const current = cleanText(player.referral_code);
    if (isValidReferralCodeString(current)) {
      const ok = await isReferralCodeOwnedByPlayerInTxn(client, current, uid);
      if (ok) {
        await upsertReferralCodeInTxn(client, current, uid, nowIso, 'authority_ensure_referral_code');
        await client.query('COMMIT');
        return { success: true as const, referralCode: current, duplicate: true };
      }
    }

    const assigned = await findFreeReferralCodeInTxn(
      client,
      buildUniqueReferralCodeCandidates(40),
      uid
    );
    if (!assigned) {
      throw new Error('Failed to assign a unique referral code. Please try again.');
    }

    let deletedOldCode = '';
    if (isValidReferralCodeString(current)) {
      const owned = await isReferralCodeOwnedByPlayerInTxn(client, current, uid);
      if (owned) {
        await tombstoneReferralCodeInTxn(client, current, 'authority_ensure_referral_code');
        deletedOldCode = current;
      }
    }

    await client.query(
      `
        UPDATE public.players_cache
        SET
          referral_code = $2,
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('referralCode', $2),
          source = 'authority_ensure_referral_code',
          mirrored_at = now()
        WHERE uid = $1 AND deleted_at IS NULL
      `,
      [uid, assigned, nowIso]
    );

    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          updated_at = $2::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object('referralCode', $3),
          source = 'authority_ensure_referral_code'
        WHERE firebase_id = $1 AND deleted_at IS NULL
      `,
      [uid, nowIso, assigned]
    );

    await upsertReferralCodeInTxn(client, assigned, uid, nowIso, 'authority_ensure_referral_code');

    await client.query('COMMIT');
    return { success: true as const, referralCode: assigned, duplicate: false, deletedOldCode };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cutWorkerRewardInSql(input: {
  coadminUid: string;
  workerUid: string;
  workerRole: string;
  workerUsername: string;
  amountNpr: number;
  reason: string;
  actorUid: string;
}) {
  const workerUid = cleanText(input.workerUid);
  const workerRole = cleanText(input.workerRole).toLowerCase();
  const coadminUid = cleanText(input.coadminUid);
  const cutAmount = Math.max(0, Math.round(Number(input.amountNpr || 0)));
  if (!workerUid || !coadminUid) throw new Error('workerUid and coadminUid are required.');
  if (workerRole !== 'staff' && workerRole !== 'carer') {
    throw new Error('workerRole must be staff or carer.');
  }
  if (cutAmount <= 0) throw new Error('Cut amount must be greater than 0.');

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const rewardCutId = randomUUID();
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const workerLock = await client.query(
      `SELECT uid, username, role, coadmin_uid, created_by, raw_firestore_data
       FROM public.players_cache WHERE uid = $1 AND deleted_at IS NULL FOR UPDATE`,
      [workerUid]
    );
    if (!workerLock.rows.length) throw new Error('Worker account not found.');
    const worker = workerLock.rows[0] as Record<string, unknown>;
    const targetScope =
      cleanText(worker.coadmin_uid) || cleanText(worker.created_by);
    if (targetScope !== coadminUid) throw new Error('Worker is outside your coadmin scope.');
    if (cleanText(worker.role).toLowerCase() !== workerRole) throw new Error('Worker role mismatch.');

    const snapLock = await client.query(
      `SELECT cash_box_npr, raw_firestore_data FROM public.user_balance_snapshots_cache
       WHERE firebase_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [workerUid]
    );
    const snap = (snapLock.rows[0] as Record<string, unknown>) || {};
    const raw = (snap.raw_firestore_data as Record<string, unknown>) || (worker.raw_firestore_data as Record<string, unknown>) || {};
    const oldCash = Math.max(0, Number(snap.cash_box_npr ?? raw.cashBoxNpr ?? 0));
    const updatedCashBox = Math.max(0, oldCash - cutAmount);

    await updatePlayerBalancesInTxn(client, workerUid, { cashBoxNpr: updatedCashBox });

    const cutRaw = {
      coadminUid,
      workerUid,
      workerRole,
      workerUsername: input.workerUsername,
      amountNpr: cutAmount,
      reason: input.reason,
      cashBoxBefore: oldCash,
      cashBoxAfter: updatedCashBox,
      cashBoxDelta: updatedCashBox - oldCash,
      actorUid: input.actorUid,
      actorRole: 'coadmin',
      sourceRewardCutId: rewardCutId,
      rewardReason: input.reason || 'Manual adjustment',
      createdAt: nowIso,
      createdByUid: input.actorUid,
    };

    await client.query(
      `
        INSERT INTO public.reward_cuts_cache (
          firebase_id, coadmin_uid, worker_uid, worker_role, worker_username,
          amount_npr, reason, created_by_uid, created_at, source, mirrored_at,
          deleted_at, raw_firestore_data
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz,
          'authority_worker_reward_cut', now(), NULL, $10::jsonb
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
        rewardCutId,
        coadminUid,
        workerUid,
        workerRole,
        input.workerUsername,
        cutAmount,
        input.reason,
        input.actorUid,
        nowIso,
        JSON.stringify(cutRaw),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `rewardCuts:${rewardCutId}:${workerUid}:cashBoxNpr:worker_reward_cut`,
      userUid: workerUid,
      username: cleanText(worker.username) || input.workerUsername,
      role: workerRole,
      coadminUid,
      balanceType: 'cashBoxNpr',
      direction: 'debit',
      delta: -cutAmount,
      absoluteAfter: updatedCashBox,
      eventType: 'worker_reward_cut',
      sourceCollection: 'reward_cuts_cache',
      sourceId: rewardCutId,
      actorUid: input.actorUid,
      actorRole: 'coadmin',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: cutRaw,
      sourceFields: { amountNpr: cutAmount, reason: input.reason },
    });

    await client.query('COMMIT');
    return { success: true as const, updatedCashBox, rewardCutId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
