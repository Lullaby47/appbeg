import 'server-only';

import type { PoolClient } from 'pg';
import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  runMirrorClientQuery,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type PlayerGameLoginCacheInput = {
  firebaseId: string;
  playerUid?: unknown;
  playerUsername?: unknown;
  gameName?: unknown;
  gameUsername?: unknown;
  gamePassword?: unknown;
  gameAccountUsername?: unknown;
  gameAccountPassword?: unknown;
  currentUsername?: unknown;
  currentPassword?: unknown;
  frontendUrl?: unknown;
  siteUrl?: unknown;
  coadminUid?: unknown;
  createdBy?: unknown;
  updatedByAutomationJobId?: unknown;
  updatedByCarerUid?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  rawFirestoreData?: Record<string, unknown>;
  source?: string;
};

function normalizeGameName(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function toCacheInput(firebaseId: string, data: Record<string, unknown>, source: string) {
  return {
    firebaseId,
    playerUid: data.playerUid,
    playerUsername: data.playerUsername,
    gameName: data.gameName,
    gameUsername: data.gameUsername,
    gamePassword: data.gamePassword,
    gameAccountUsername: data.gameAccountUsername,
    gameAccountPassword: data.gameAccountPassword,
    currentUsername: data.currentUsername,
    currentPassword: data.currentPassword,
    frontendUrl: data.frontendUrl,
    siteUrl: data.siteUrl,
    coadminUid: data.coadminUid,
    createdBy: data.createdBy,
    updatedByAutomationJobId: data.updatedByAutomationJobId,
    updatedByCarerUid: data.updatedByCarerUid,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    rawFirestoreData: data,
    source,
  } satisfies PlayerGameLoginCacheInput;
}

export async function upsertPlayerGameLoginCache(input: PlayerGameLoginCacheInput) {
  const db = getPlayerMirrorPool();
  const firebaseId = cleanText(input.firebaseId);
  if (!db || !firebaseId) return false;

  const playerUid = cleanText(input.playerUid);
  const gameName = cleanText(input.gameName);
  const normalizedGameName = normalizeGameName(gameName);
  if (!playerUid || !gameName || !normalizedGameName) {
    console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', {
      firebaseId,
      reason: 'missing_required_fields',
      playerUid: playerUid || null,
      gameName: gameName || null,
    });
    return false;
  }

  try {
    await db.query(
      `
        INSERT INTO public.player_game_logins_cache (
          firebase_id,
          player_uid,
          player_username,
          game_name,
          normalized_game_name,
          game_username,
          game_password,
          game_account_username,
          game_account_password,
          current_username,
          current_password,
          frontend_url,
          site_url,
          coadmin_uid,
          created_by,
          updated_by_automation_job_id,
          updated_by_carer_uid,
          created_at,
          updated_at,
          source,
          mirrored_at,
          deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, $2, NULLIF($3, ''), $4, $5, NULLIF($6, ''), NULLIF($7, ''),
          NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''),
          NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''),
          NULLIF($16, ''), NULLIF($17, ''), $18::timestamptz, $19::timestamptz,
          $20, now(), NULL, $21::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          player_uid = EXCLUDED.player_uid,
          player_username = EXCLUDED.player_username,
          game_name = EXCLUDED.game_name,
          normalized_game_name = EXCLUDED.normalized_game_name,
          game_username = EXCLUDED.game_username,
          game_password = EXCLUDED.game_password,
          game_account_username = EXCLUDED.game_account_username,
          game_account_password = EXCLUDED.game_account_password,
          current_username = EXCLUDED.current_username,
          current_password = EXCLUDED.current_password,
          frontend_url = EXCLUDED.frontend_url,
          site_url = EXCLUDED.site_url,
          coadmin_uid = EXCLUDED.coadmin_uid,
          created_by = EXCLUDED.created_by,
          updated_by_automation_job_id = EXCLUDED.updated_by_automation_job_id,
          updated_by_carer_uid = EXCLUDED.updated_by_carer_uid,
          created_at = COALESCE(public.player_game_logins_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        firebaseId,
        playerUid,
        cleanText(input.playerUsername),
        gameName,
        normalizedGameName,
        cleanText(input.gameUsername),
        String(input.gamePassword || ''),
        cleanText(input.gameAccountUsername),
        String(input.gameAccountPassword || ''),
        cleanText(input.currentUsername),
        String(input.currentPassword || ''),
        cleanText(input.frontendUrl),
        cleanText(input.siteUrl),
        cleanText(input.coadminUid),
        cleanText(input.createdBy),
        cleanText(input.updatedByAutomationJobId),
        cleanText(input.updatedByCarerUid),
        toIsoString(input.createdAt),
        toIsoString(input.updatedAt),
        cleanText(input.source) || 'appbeg',
        JSON.stringify(normalizeJson(input.rawFirestoreData || {}) || {}),
      ]
    );
    console.info('[PLAYER_GAME_LOGINS_CACHE] mirror upsert ok', { firebaseId });
    return true;
  } catch (error) {
    console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', { firebaseId, error });
    return false;
  }
}

export async function mirrorPlayerGameLoginSnapshot(snap: DocumentSnapshot, source = 'appbeg') {
  if (!snap.exists) return false;
  return upsertPlayerGameLoginCache(
    toCacheInput(snap.id, (snap.data() || {}) as Record<string, unknown>, source)
  );
}

export async function mirrorPlayerGameLoginById(firebaseId: string, source = 'appbeg') {
  const cleanId = cleanText(firebaseId);
  if (!cleanId) return false;
  try {
    return mirrorPlayerGameLoginSnapshot(
      await adminDb.collection('playerGameLogins').doc(cleanId).get(),
      source
    );
  } catch (error) {
    console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function tombstonePlayerGameLoginCache(firebaseId: string, source = 'appbeg') {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return false;
  try {
    await db.query(
      `
        INSERT INTO public.player_game_logins_cache (
          firebase_id,
          player_uid,
          game_name,
          normalized_game_name,
          source,
          mirrored_at,
          deleted_at,
          raw_firestore_data
        )
        VALUES ($1, $1, $1, $1, $2, now(), now(), '{}'::jsonb)
        ON CONFLICT (firebase_id) DO UPDATE SET
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = now()
      `,
      [cleanId, source]
    );
    console.info('[PLAYER_GAME_LOGINS_CACHE] tombstone ok', { firebaseId: cleanId });
    return true;
  } catch (error) {
    console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return false;
  }
}

export async function getPlayerGameLoginCacheById(firebaseId: string) {
  const db = getPlayerMirrorPool();
  const cleanId = cleanText(firebaseId);
  if (!db || !cleanId) return null;
  try {
    const result = await db.query(
      `
        SELECT *
        FROM public.player_game_logins_cache
        WHERE firebase_id = $1
        LIMIT 1
      `,
      [cleanId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[PLAYER_GAME_LOGINS_CACHE] mirror failed', { firebaseId: cleanId, error });
    return null;
  }
}

export type CachedPlayerGameLogin = {
  id: string;
  playerUid: string;
  playerUsername: string;
  gameName: string;
  gameUsername: string;
  gamePassword: string;
  frontendUrl?: string;
  siteUrl?: string;
  coadminUid: string;
  createdBy: string;
  createdAt?: string | null;
};

function mapCachedPlayerGameLoginRow(
  row: Record<string, unknown>,
  requestedCoadminUid: string
): CachedPlayerGameLogin | null {
  const id = cleanText(row.firebase_id);
  const playerUid = cleanText(row.player_uid);
  const gameName = cleanText(row.game_name);
  const createdBy = cleanText(row.created_by) || requestedCoadminUid;
  const coadminUid = cleanText(row.coadmin_uid) || createdBy;

  if (!id || !playerUid || !gameName || !coadminUid || !createdBy) {
    return null;
  }

  return {
    id,
    playerUid,
    playerUsername: cleanText(row.player_username),
    gameName,
    gameUsername: cleanText(row.game_username),
    gamePassword: String(row.game_password || ''),
    frontendUrl: cleanText(row.frontend_url) || undefined,
    siteUrl: cleanText(row.site_url) || undefined,
    coadminUid,
    createdBy,
    createdAt: toIsoString(row.created_at),
  };
}

const PLAYER_GAME_LOGINS_BY_PLAYER_SQL = `
  SELECT DISTINCT ON (firebase_id)
    firebase_id,
    player_uid,
    game_name,
    game_username,
    normalized_game_name
  FROM public.player_game_logins_cache
  WHERE deleted_at IS NULL
    AND player_uid = $1
  ORDER BY firebase_id, COALESCE(updated_at, created_at, mirrored_at) DESC
`;

export type PlayerGameLoginByPlayerRow = {
  gameName: string;
  gameUsername: string;
};

function mapPlayerGameLoginByPlayerRows(rows: Record<string, unknown>[]): PlayerGameLoginByPlayerRow[] {
  return rows
    .map((row) => ({
      gameName: cleanText(row.game_name),
      gameUsername: cleanText(row.game_username),
    }))
    .filter((row) => row.gameName);
}

export async function readPlayerGameLoginsCacheByPlayerWithClient(
  client: PoolClient,
  playerUid: string
): Promise<PlayerGameLoginByPlayerRow[]> {
  const cleanPlayerUid = cleanText(playerUid);
  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    PLAYER_GAME_LOGINS_BY_PLAYER_SQL,
    [cleanPlayerUid]
  );
  return mapPlayerGameLoginByPlayerRows(rows);
}

export async function readPlayerGameLoginsCacheByPlayer(
  playerUid: string
): Promise<PlayerGameLoginByPlayerRow[] | null> {
  const cleanPlayerUid = cleanText(playerUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanPlayerUid) {
    return null;
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      PLAYER_GAME_LOGINS_BY_PLAYER_SQL,
      [cleanPlayerUid]
    );
    return mapPlayerGameLoginByPlayerRows(rows);
  } catch (error) {
    console.warn('[PLAYER_GAME_LOGINS_CACHE] postgres read by player failed', {
      playerUid: cleanPlayerUid,
      error,
    });
    return null;
  }
}

/** Alias for recharge Finance Layer 1 reads. */
export const readPlayerGameLoginsCacheByPlayerUid = readPlayerGameLoginsCacheByPlayer;

const PLAYER_GAME_LOGINS_BY_COADMIN_SQL = `
  SELECT DISTINCT ON (firebase_id)
    firebase_id,
    player_uid,
    player_username,
    game_name,
    game_username,
    game_password,
    frontend_url,
    site_url,
    coadmin_uid,
    created_by,
    created_at,
    updated_at,
    mirrored_at
  FROM public.player_game_logins_cache
  WHERE deleted_at IS NULL
    AND (coadmin_uid = $1 OR created_by = $1)
  ORDER BY firebase_id, COALESCE(updated_at, created_at, mirrored_at) DESC
`;

function sortCachedPlayerGameLogins(logins: CachedPlayerGameLogin[]) {
  return logins.sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function mapCachedPlayerGameLoginRows(
  rows: Record<string, unknown>[],
  requestedCoadminUid: string
): CachedPlayerGameLogin[] {
  return sortCachedPlayerGameLogins(
    rows
      .map((row) => mapCachedPlayerGameLoginRow(row, requestedCoadminUid))
      .filter((login): login is CachedPlayerGameLogin => Boolean(login))
  );
}

export async function readPlayerGameLoginsCacheByCoadminWithClient(
  client: PoolClient,
  coadminUid: string
): Promise<CachedPlayerGameLogin[]> {
  const cleanCoadminUid = cleanText(coadminUid);
  const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
    client,
    PLAYER_GAME_LOGINS_BY_COADMIN_SQL,
    [cleanCoadminUid]
  );
  return mapCachedPlayerGameLoginRows(rows, cleanCoadminUid);
}

export async function readPlayerGameLoginsCacheByCoadmin(
  coadminUid: string
): Promise<CachedPlayerGameLogin[] | null> {
  const cleanCoadminUid = cleanText(coadminUid);
  const db = getPlayerMirrorPool();
  if (!db || !cleanCoadminUid) {
    return null;
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      PLAYER_GAME_LOGINS_BY_COADMIN_SQL,
      [cleanCoadminUid]
    );
    return mapCachedPlayerGameLoginRows(rows, cleanCoadminUid);
  } catch (error) {
    console.warn('[PLAYER_GAME_LOGINS_CACHE] postgres read failed', {
      coadminUid: cleanCoadminUid,
      error,
    });
    return null;
  }
}

export type CurrentUsernameSqlLookupResult = {
  username: string | null;
  hit: boolean;
  missReason: 'postgres_unavailable' | 'lookup_failed' | 'row_missing' | 'missing_field' | null;
  durationMs: number;
};

export async function lookupCurrentUsernameForTaskFromSql(
  coadminUid: string,
  playerUid: string,
  gameName: string
): Promise<CurrentUsernameSqlLookupResult> {
  const startedAt = Date.now();
  const cleanCoadminUid = cleanText(coadminUid);
  const cleanPlayerUid = cleanText(playerUid);
  const target = normalizeGameName(gameName);
  const db = getPlayerMirrorPool();

  if (!db || !cleanCoadminUid || !cleanPlayerUid || !target) {
    return {
      username: null,
      hit: false,
      missReason: 'missing_field',
      durationMs: Date.now() - startedAt,
    };
  }

  const usernameSql = `
    SELECT game_username, coadmin_uid, game_name, normalized_game_name
    FROM public.player_game_logins_cache
    WHERE player_uid = $1
      AND deleted_at IS NULL
      AND coadmin_uid = $2
    ORDER BY updated_at DESC NULLS LAST, mirrored_at DESC
    LIMIT 80
  `;

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(db, usernameSql, [
      cleanPlayerUid,
      cleanCoadminUid,
    ]);
    const durationMs = Date.now() - startedAt;

    for (const row of rows) {
      if (cleanText(row.coadmin_uid) !== cleanCoadminUid) {
        continue;
      }
      const rowGame =
        cleanText(row.normalized_game_name) || normalizeGameName(cleanText(row.game_name));
      if (rowGame !== target) {
        continue;
      }
      const username = cleanText(row.game_username);
      return {
        username: username || null,
        hit: Boolean(username),
        missReason: username ? null : 'missing_field',
        durationMs,
      };
    }

    return {
      username: null,
      hit: false,
      missReason: 'row_missing',
      durationMs,
    };
  } catch (error) {
    console.error('[PLAYER_GAME_LOGINS_CACHE] lookup failed', {
      coadminUid: cleanCoadminUid,
      playerUid: cleanPlayerUid,
      gameName: target,
      error,
    });
    return {
      username: null,
      hit: false,
      missReason: 'lookup_failed',
      durationMs: Date.now() - startedAt,
    };
  }
}
