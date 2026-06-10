import 'server-only';

import { randomUUID } from 'crypto';

import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type CachedCoinLoadSession = {
  id: string;
  playerUid: string;
  coadminUid: string;
  paymentPhotoUrl: string;
  createdAt: string;
  expiresAt: string;
};

const COIN_LOAD_DURATION_MS = 10 * 60 * 1000;

function mapRow(row: Record<string, unknown>): CachedCoinLoadSession | null {
  const id = cleanText(row.session_id);
  const playerUid = cleanText(row.player_uid);
  const coadminUid = cleanText(row.coadmin_uid);
  const paymentPhotoUrl = cleanText(row.payment_photo_url);
  const expiresAt = toIsoString(row.expires_at);
  const createdAt = toIsoString(row.created_at);
  if (!id || !playerUid || !coadminUid || !paymentPhotoUrl || !expiresAt) {
    return null;
  }
  return {
    id,
    playerUid,
    coadminUid,
    paymentPhotoUrl,
    createdAt: createdAt || new Date().toISOString(),
    expiresAt,
  };
}

export async function tombstoneCoinLoadSessionsForPlayer(playerUid: string) {
  const db = getPlayerMirrorPool();
  const cleanPlayerUid = cleanText(playerUid);
  if (!db || !cleanPlayerUid) {
    return false;
  }
  await db.query(
    `
      UPDATE public.coin_load_sessions_cache
      SET deleted_at = now(), mirrored_at = now()
      WHERE player_uid = $1 AND deleted_at IS NULL
    `,
    [cleanPlayerUid]
  );
  return true;
}

export async function createCoinLoadSessionInSql(input: {
  playerUid: string;
  coadminUid: string;
  paymentPhotoUrl: string;
}) {
  const db = getPlayerMirrorPool();
  const playerUid = cleanText(input.playerUid);
  const coadminUid = cleanText(input.coadminUid);
  const paymentPhotoUrl = cleanText(input.paymentPhotoUrl);
  if (!db || !playerUid || !coadminUid || !paymentPhotoUrl) {
    return null;
  }

  const sessionId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + COIN_LOAD_DURATION_MS);

  await tombstoneCoinLoadSessionsForPlayer(playerUid);

  await db.query(
    `
      INSERT INTO public.coin_load_sessions_cache (
        session_id, player_uid, coadmin_uid, payment_photo_url,
        created_at, expires_at, source, mirrored_at, deleted_at
      )
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 'authority', now(), NULL)
    `,
    [
      sessionId,
      playerUid,
      coadminUid,
      paymentPhotoUrl,
      now.toISOString(),
      expiresAt.toISOString(),
    ]
  );

  return {
    id: sessionId,
    playerUid,
    coadminUid,
    paymentPhotoUrl,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  } satisfies CachedCoinLoadSession;
}

export async function readCoinLoadSessionById(sessionId: string, playerUid?: string) {
  const db = getPlayerMirrorPool();
  const cleanSessionId = cleanText(sessionId);
  if (!db || !cleanSessionId) {
    return null;
  }

  const params: unknown[] = [cleanSessionId];
  let sql = `
    SELECT *
    FROM public.coin_load_sessions_cache
    WHERE session_id = $1 AND deleted_at IS NULL
  `;
  if (playerUid) {
    params.push(cleanText(playerUid));
    sql += ` AND player_uid = $${params.length}`;
  }
  sql += ' LIMIT 1';

  const result = await db.query(sql, params);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export async function deleteCoinLoadSessionInSql(sessionId: string, playerUid: string) {
  const db = getPlayerMirrorPool();
  const cleanSessionId = cleanText(sessionId);
  const cleanPlayerUid = cleanText(playerUid);
  if (!db || !cleanSessionId || !cleanPlayerUid) {
    return false;
  }
  const result = await db.query(
    `
      UPDATE public.coin_load_sessions_cache
      SET deleted_at = now(), mirrored_at = now()
      WHERE session_id = $1 AND player_uid = $2 AND deleted_at IS NULL
    `,
    [cleanSessionId, cleanPlayerUid]
  );
  return (result.rowCount || 0) > 0;
}
