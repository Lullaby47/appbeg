import 'server-only';

import type { PoolClient } from 'pg';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

const PLAYER_LOGIN_GAME = 'player_login';

type GameUsernameInput = {
  username: string;
  playerUid: string;
  coadminUid: string;
  source: string;
  game?: string;
};

type DeactivateGameUsernameSqlInput = {
  username?: string | null;
  playerUid: string;
  coadminUid?: string | null;
  reason: string;
  source: string;
};

function rawPayload(input: Record<string, unknown>) {
  return JSON.stringify(input);
}

export async function upsertGameUsernameForPlayerInTxn(
  client: PoolClient,
  input: GameUsernameInput
) {
  const username = cleanText(input.username);
  const playerUid = cleanText(input.playerUid);
  const coadminUid = cleanText(input.coadminUid);
  const source = cleanText(input.source) || 'appbeg';
  const game = cleanText(input.game) || PLAYER_LOGIN_GAME;
  if (!username || !playerUid || !coadminUid) {
    return { upserted: false as const, reason: 'missing_required_fields' };
  }

  const nowIso = new Date().toISOString();
  const raw = rawPayload({
    username,
    playerUid,
    coadminUid,
    game,
    source,
    status: 'active',
    updatedAt: nowIso,
  });

  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM public.game_usernames
      WHERE lower(username) = lower($1)
        AND coadmin_uid = $2
        AND status = 'active'
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
      FOR UPDATE
    `,
    [username, coadminUid]
  );

  if (existing.rows.length) {
    await client.query(
      `
        UPDATE public.game_usernames
        SET username = $1,
            game = $2,
            player_uid = $3,
            coadmin_uid = $4,
            source = $5,
            status = 'active',
            updated_at = $6::timestamptz,
            deactivated_at = NULL,
            deactivate_reason = NULL,
            mirrored_at = now(),
            raw_json = COALESCE(raw_json, '{}'::jsonb) || $7::jsonb
        WHERE id = $8
      `,
      [username, game, playerUid, coadminUid, source, nowIso, raw, existing.rows[0].id]
    );
    console.info('[GAME_USERNAME_UPSERT]', {
      action: 'update',
      username,
      playerUid,
      coadminUid,
      source,
    });
    return { upserted: true as const, action: 'update' as const };
  }

  await client.query(
    `
      INSERT INTO public.game_usernames (
        username, game, player_uid, coadmin_uid, source, status, updated_at,
        mirrored_at, raw_json
      )
      VALUES ($1, $2, $3, $4, $5, 'active', $6::timestamptz, now(), $7::jsonb)
    `,
    [username, game, playerUid, coadminUid, source, nowIso, raw]
  );
  console.info('[GAME_USERNAME_UPSERT]', {
    action: 'insert',
    username,
    playerUid,
    coadminUid,
    source,
  });
  return { upserted: true as const, action: 'insert' as const };
}

export async function upsertGameUsernameForPlayer(input: GameUsernameInput) {
  const db = getPlayerMirrorPool();
  if (!db) return { upserted: false as const, reason: 'postgres_unavailable' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await upsertGameUsernameForPlayerInTxn(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deactivateGameUsernameForPlayerInTxn(
  client: PoolClient,
  input: DeactivateGameUsernameSqlInput
) {
  const playerUid = cleanText(input.playerUid);
  const username = cleanText(input.username);
  const coadminUid = cleanText(input.coadminUid);
  const reason = cleanText(input.reason) || 'deleted';
  const source = cleanText(input.source) || 'appbeg';
  if (!playerUid) {
    return { deactivated: false as const, count: 0, reason: 'missing_player_uid' };
  }

  const result = await client.query(
    `
      UPDATE public.game_usernames
      SET status = 'inactive',
          updated_at = now(),
          deactivated_at = now(),
          deactivate_reason = $4,
          source = $5,
          mirrored_at = now()
      WHERE status = 'active'
        AND (
          player_uid = $1
          OR (
            NULLIF($2, '') IS NOT NULL
            AND lower(username) = lower($2)
            AND (NULLIF($3, '') IS NULL OR coadmin_uid = $3)
          )
        )
    `,
    [playerUid, username, coadminUid, reason, source]
  );
  const count = result.rowCount || 0;
  console.info('[GAME_USERNAME_DEACTIVATE]', {
    playerUid,
    username: username || null,
    coadminUid: coadminUid || null,
    reason,
    source,
    count,
  });
  return { deactivated: count > 0, count };
}
