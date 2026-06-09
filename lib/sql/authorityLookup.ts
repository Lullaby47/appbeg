import 'server-only';

import type { PoolClient } from 'pg';

import { cleanText, getPlayerMirrorPool, runMirrorClientQuery } from '@/lib/sql/playerMirrorCommon';

export type UserDirectorySqlRow = {
  uid: string;
  username: string | null;
  email: string | null;
  role: string;
  status: string | null;
  coadminUid: string | null;
  createdBy: string | null;
  coin: number;
  cash: number;
};

function mapUserDirectoryRow(row: Record<string, unknown>): UserDirectorySqlRow {
  const raw =
    row.raw_firestore_data && typeof row.raw_firestore_data === 'object' && !Array.isArray(row.raw_firestore_data)
      ? (row.raw_firestore_data as Record<string, unknown>)
      : {};
  return {
    uid: cleanText(row.uid),
    username: cleanText(row.username) || cleanText(raw.username) || null,
    email: cleanText(row.email) || cleanText(raw.email) || null,
    role: cleanText(row.role) || cleanText(raw.role) || 'player',
    status: cleanText(row.status) || cleanText(raw.status) || null,
    coadminUid: cleanText(row.coadmin_uid) || cleanText(raw.coadminUid) || null,
    createdBy: cleanText(row.created_by) || cleanText(raw.createdBy) || null,
    coin: Math.max(0, Math.floor(Number(row.coin ?? raw.coin ?? 0))),
    cash: Math.max(0, Math.floor(Number(row.cash ?? raw.cash ?? 0))),
  };
}

const USER_DIRECTORY_SQL = `
  SELECT
    uid,
    username,
    email,
    role,
    status,
    coadmin_uid,
    created_by,
    coin,
    cash,
    raw_firestore_data
  FROM public.players_cache
  WHERE uid = $1
    AND deleted_at IS NULL
  LIMIT 1
`;

export async function lookupUserDirectoryFromSql(
  uid: string,
  client?: PoolClient
): Promise<UserDirectorySqlRow | null> {
  const cleanUid = cleanText(uid);
  if (!cleanUid) {
    return null;
  }

  if (client) {
    const { rows } = await runMirrorClientQuery<Record<string, unknown>>(client, USER_DIRECTORY_SQL, [
      cleanUid,
    ]);
    return rows.length ? mapUserDirectoryRow(rows[0]) : null;
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    return null;
  }

  const result = await db.query(USER_DIRECTORY_SQL, [cleanUid]);
  if (!result.rows.length) {
    return null;
  }
  return mapUserDirectoryRow(result.rows[0] as Record<string, unknown>);
}

export function resolvePlayerScopeUid(user: Pick<UserDirectorySqlRow, 'coadminUid' | 'createdBy'>) {
  return cleanText(user.coadminUid) || cleanText(user.createdBy);
}
