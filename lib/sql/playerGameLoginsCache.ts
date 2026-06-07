import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
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
