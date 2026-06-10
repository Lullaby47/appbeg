import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type CachedShiftSession = {
  id: string;
  coadminUid: string;
  userUid: string;
  userRole: string;
  userUsername: string;
  loginAt: string | null;
  logoutAt: string | null;
  lastSeenAt: string | null;
  isActive: boolean;
};

function mapRow(row: Record<string, unknown>): CachedShiftSession | null {
  const id = cleanText(row.session_id);
  const userUid = cleanText(row.user_uid);
  if (!id || !userUid) {
    return null;
  }
  return {
    id,
    coadminUid: cleanText(row.coadmin_uid),
    userUid,
    userRole: cleanText(row.user_role) || 'staff',
    userUsername: cleanText(row.user_username) || 'User',
    loginAt: toIsoString(row.login_at),
    logoutAt: toIsoString(row.logout_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    isActive: Boolean(row.is_active),
  };
}

async function deactivateActiveSessionsForUser(client: PoolClient, userUid: string, nowIso: string) {
  await client.query(
    `
      UPDATE public.shift_sessions_cache
      SET is_active = false,
          logout_at = COALESCE(logout_at, $2::timestamptz),
          last_seen_at = $2::timestamptz,
          mirrored_at = now()
      WHERE user_uid = $1 AND is_active = true AND deleted_at IS NULL
    `,
    [userUid, nowIso]
  );
}

export async function startShiftSessionInSql(input: {
  coadminUid: string;
  userUid: string;
  userRole: string;
  userUsername: string;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const userUid = cleanText(input.userUid);
  const userRole = cleanText(input.userRole) || 'staff';
  const userUsername = cleanText(input.userUsername) || 'User';
  if (!db || !coadminUid || !userUid) {
    return null;
  }

  const sessionId = randomUUID();
  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await deactivateActiveSessionsForUser(client, userUid, nowIso);
    await client.query(
      `
        INSERT INTO public.shift_sessions_cache (
          session_id, coadmin_uid, user_uid, user_role, user_username,
          login_at, logout_at, last_seen_at, is_active, source, mirrored_at, deleted_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, NULL, $6::timestamptz, true, 'authority', now(), NULL)
      `,
      [sessionId, coadminUid, userUid, userRole, userUsername, nowIso]
    );
    await client.query('COMMIT');
    return sessionId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatShiftSessionInSql(sessionId: string, userUid: string) {
  const db = getPlayerMirrorPool();
  const cleanSessionId = cleanText(sessionId);
  const cleanUserUid = cleanText(userUid);
  if (!db || !cleanSessionId || !cleanUserUid) {
    return false;
  }
  const nowIso = new Date().toISOString();
  const result = await db.query(
    `
      UPDATE public.shift_sessions_cache
      SET last_seen_at = $3::timestamptz, is_active = true, mirrored_at = now()
      WHERE session_id = $1 AND user_uid = $2 AND deleted_at IS NULL
    `,
    [cleanSessionId, cleanUserUid, nowIso]
  );
  return (result.rowCount || 0) > 0;
}

export async function endShiftSessionInSql(sessionId: string, userUid: string) {
  const db = getPlayerMirrorPool();
  const cleanSessionId = cleanText(sessionId);
  const cleanUserUid = cleanText(userUid);
  if (!db || !cleanSessionId || !cleanUserUid) {
    return false;
  }
  const nowIso = new Date().toISOString();
  const result = await db.query(
    `
      UPDATE public.shift_sessions_cache
      SET is_active = false,
          logout_at = $3::timestamptz,
          last_seen_at = $3::timestamptz,
          mirrored_at = now()
      WHERE session_id = $1 AND user_uid = $2 AND deleted_at IS NULL
    `,
    [cleanSessionId, cleanUserUid, nowIso]
  );
  return (result.rowCount || 0) > 0;
}

export async function readShiftSessionsByCoadmin(coadminUid: string) {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  if (!db || !cleanCoadminUid) {
    return null;
  }
  const result = await db.query(
    `
      SELECT *
      FROM public.shift_sessions_cache
      WHERE coadmin_uid = $1 AND deleted_at IS NULL
      ORDER BY COALESCE(last_seen_at, login_at, mirrored_at) DESC
    `,
    [cleanCoadminUid]
  );
  return result.rows
    .map((row) => mapRow(row as Record<string, unknown>))
    .filter((row): row is CachedShiftSession => Boolean(row));
}
