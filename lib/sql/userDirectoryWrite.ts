import 'server-only';

import { hashPassword } from '@/lib/auth/passwordHash';
import { cleanText, getPlayerMirrorPool, normalizeJson } from '@/lib/sql/playerMirrorCommon';

const SQL_CREATE_SOURCE = 'sql_create';

export type UserDirectoryStatus = 'active' | 'disabled';

function isUserDirectoryStatus(value: string): value is UserDirectoryStatus {
  return value === 'active' || value === 'disabled';
}

export type CreateUserDirectoryInSqlInput = {
  uid: string;
  username: string;
  email: string;
  role: string;
  status?: UserDirectoryStatus;
  coadminUid?: string | null;
  createdBy?: string | null;
  createdByStaffId?: string | null;
  password: string;
  rawData?: Record<string, unknown>;
  actorUid: string;
  actorRole: string;
};

export type CreateUserDirectoryInSqlResult = {
  directoryCreated: boolean;
  credentialsCreated: boolean;
  balanceSnapshotCreated: boolean;
};

export async function isActiveUsernameTakenInSql(username: string) {
  const db = getPlayerMirrorPool();
  const cleanUsername = cleanText(username);
  if (!db || !cleanUsername) {
    return false;
  }

  try {
    const result = await db.query(
      `
        SELECT uid
        FROM public.players_cache
        WHERE deleted_at IS NULL
          AND LOWER(username) = LOWER($1)
        LIMIT 1
      `,
      [cleanUsername]
    );
    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.warn('[USER_DIRECTORY_SQL] username lookup failed', {
      username: cleanUsername,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function buildRawFirestoreData(input: CreateUserDirectoryInSqlInput, nowIso: string) {
  return normalizeJson({
    uid: input.uid,
    username: input.username,
    email: input.email,
    role: input.role,
    status: input.status || 'active',
    createdBy: input.createdBy || null,
    coadminUid: input.coadminUid || null,
    createdByStaffId: input.createdByStaffId || null,
    createdAt: nowIso,
    ...(input.rawData || {}),
  }) as Record<string, unknown>;
}

export async function createUserDirectoryInSql(
  input: CreateUserDirectoryInSqlInput
): Promise<CreateUserDirectoryInSqlResult> {
  const uid = cleanText(input.uid);
  const username = cleanText(input.username);
  const email = cleanText(input.email);
  const role = cleanText(input.role).toLowerCase();
  const status = cleanText(input.status || 'active').toLowerCase();
  const password = String(input.password || '');
  const coadminUid = cleanText(input.coadminUid) || null;
  const createdBy = cleanText(input.createdBy) || null;
  const createdByStaffId = cleanText(input.createdByStaffId) || null;
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);

  if (!uid || !username || !email || !role) {
    throw new Error('uid, username, email, and role are required.');
  }
  if (!['coadmin', 'staff', 'carer'].includes(role)) {
    throw new Error('Only coadmin, staff, and carer users can be created in SQL directory.');
  }
  if (!isUserDirectoryStatus(status)) {
    throw new Error('status must be active or disabled.');
  }
  if (password.length < 6) {
    throw new Error('password must be at least 6 characters.');
  }
  if (!actorUid || !actorRole) {
    throw new Error('actorUid and actorRole are required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const hashed = await hashPassword(password);
  const nowIso = new Date().toISOString();
  const rawFirestoreData = JSON.stringify(buildRawFirestoreData(input, nowIso));

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `
        INSERT INTO public.players_cache (
          uid,
          username,
          email,
          role,
          status,
          created_by,
          coadmin_uid,
          created_by_staff_id,
          created_at,
          updated_at,
          raw_firestore_data,
          source,
          mirrored_at,
          deleted_at
        )
        VALUES (
          $1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''),
          NULLIF($8, ''), $9::timestamptz, $9::timestamptz, $10::jsonb, $11, now(), NULL
        )
        ON CONFLICT (uid) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          created_by = EXCLUDED.created_by,
          coadmin_uid = EXCLUDED.coadmin_uid,
          created_by_staff_id = EXCLUDED.created_by_staff_id,
          created_at = COALESCE(public.players_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          raw_firestore_data = EXCLUDED.raw_firestore_data,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [
        uid,
        username,
        email,
        role,
        status,
        createdBy,
        coadminUid,
        createdByStaffId,
        nowIso,
        rawFirestoreData,
        SQL_CREATE_SOURCE,
      ]
    );

    await client.query(
      `
        INSERT INTO public.user_credentials (
          uid,
          password_hash,
          password_algo,
          password_updated_at,
          migrated_from_firebase,
          must_reset,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4::timestamptz, FALSE, FALSE, $4::timestamptz, $4::timestamptz)
        ON CONFLICT (uid) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          password_algo = EXCLUDED.password_algo,
          password_updated_at = EXCLUDED.password_updated_at,
          migrated_from_firebase = FALSE,
          must_reset = FALSE,
          updated_at = EXCLUDED.updated_at
      `,
      [uid, hashed.hash, hashed.algo, nowIso]
    );

    await client.query(
      `
        INSERT INTO public.user_balance_snapshots_cache (
          firebase_id,
          username,
          email,
          role,
          status,
          coadmin_uid,
          created_by,
          created_at,
          updated_at,
          source,
          mirrored_at,
          deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
          NULLIF($6, ''), NULLIF($7, ''), $8::timestamptz, $8::timestamptz,
          $9, now(), NULL, $10::jsonb
        )
        ON CONFLICT (firebase_id) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          coadmin_uid = EXCLUDED.coadmin_uid,
          created_by = EXCLUDED.created_by,
          created_at = COALESCE(public.user_balance_snapshots_cache.created_at, EXCLUDED.created_at),
          updated_at = EXCLUDED.updated_at,
          source = EXCLUDED.source,
          mirrored_at = now(),
          deleted_at = NULL,
          raw_firestore_data = EXCLUDED.raw_firestore_data
      `,
      [
        uid,
        username,
        email,
        role,
        status,
        coadminUid,
        createdBy,
        nowIso,
        SQL_CREATE_SOURCE,
        rawFirestoreData,
      ]
    );

    await client.query('COMMIT');
    return {
      directoryCreated: true,
      credentialsCreated: true,
      balanceSnapshotCreated: true,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const SQL_DELETE_SOURCE = 'sql_delete';

export type DeleteUserDirectoryInSqlInput = {
  uid: string;
  actorUid: string;
  actorRole: string;
  reason?: string;
  hardDeleteCredentials?: boolean;
};

export type DeleteUserDirectoryInSqlResult = {
  directoryTombstoned: boolean;
  balanceSnapshotTombstoned: boolean;
  sessionsRevoked: number;
  credentialsDeleted: number;
};

export async function deleteUserDirectoryInSql(
  input: DeleteUserDirectoryInSqlInput
): Promise<DeleteUserDirectoryInSqlResult> {
  const uid = cleanText(input.uid);
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  const revokeReason = cleanText(input.reason) || 'user_deleted';
  const hardDeleteCredentials = input.hardDeleteCredentials ?? true;

  if (!uid) {
    throw new Error('uid is required.');
  }
  if (!actorUid || !actorRole) {
    throw new Error('actorUid and actorRole are required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const directoryResult = await client.query(
      `
        UPDATE public.players_cache
        SET
          deleted_at = $2::timestamptz,
          updated_at = $2::timestamptz,
          source = $4::text,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'deleted', TRUE,
            'deletedAt', $2::text,
            'deletedByUid', $3::text,
            'deletedByRole', $5::text
          )
        WHERE uid = $1::text
      `,
      [uid, nowIso, actorUid, SQL_DELETE_SOURCE, actorRole]
    );
    let directoryTombstoned = (directoryResult.rowCount || 0) > 0;
    if (!directoryTombstoned) {
      const insertDirectoryResult = await client.query(
        `
          INSERT INTO public.players_cache (
            uid, username, role, raw_firestore_data, source, mirrored_at, deleted_at, updated_at
          )
          VALUES (
            $1::text, $1::text, 'unknown', jsonb_build_object(
              'deleted', TRUE,
              'deletedAt', $2::text,
              'deletedByUid', $3::text,
              'deletedByRole', $4::text
            ), $5::text, now(), $2::timestamptz, $2::timestamptz
          )
          ON CONFLICT (uid) DO UPDATE SET
            deleted_at = EXCLUDED.deleted_at,
            updated_at = EXCLUDED.updated_at,
            source = EXCLUDED.source,
            mirrored_at = now(),
            raw_firestore_data = COALESCE(public.players_cache.raw_firestore_data, '{}'::jsonb)
              || EXCLUDED.raw_firestore_data
        `,
        [uid, nowIso, actorUid, actorRole, SQL_DELETE_SOURCE]
      );
      directoryTombstoned = (insertDirectoryResult.rowCount || 0) > 0;
    }

    let credentialsDeleted = 0;
    if (hardDeleteCredentials) {
      const credentialsResult = await client.query(
        `DELETE FROM public.user_credentials WHERE uid = $1::text`,
        [uid]
      );
      credentialsDeleted = credentialsResult.rowCount || 0;
    }

    const balanceSnapshotResult = await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          deleted_at = $2::timestamptz,
          updated_at = $2::timestamptz,
          mirrored_at = now(),
          source = $4::text,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'deleted', TRUE,
            'deletedAt', $2::text,
            'deletedByUid', $3::text,
            'deletedByRole', $5::text
          )
        WHERE firebase_id = $1::text
      `,
      [uid, nowIso, actorUid, SQL_DELETE_SOURCE, actorRole]
    );
    let balanceSnapshotTombstoned = (balanceSnapshotResult.rowCount || 0) > 0;
    if (!balanceSnapshotTombstoned) {
      const insertBalanceResult = await client.query(
        `
          INSERT INTO public.user_balance_snapshots_cache (
            firebase_id, source, mirrored_at, deleted_at, updated_at, raw_firestore_data
          )
          VALUES (
            $1::text, $2::text, now(), $3::timestamptz, $3::timestamptz,
            jsonb_build_object(
              'deleted', TRUE,
              'deletedAt', $3::text,
              'deletedByUid', $4::text,
              'deletedByRole', $5::text
            )
          )
          ON CONFLICT (firebase_id) DO UPDATE SET
            deleted_at = EXCLUDED.deleted_at,
            updated_at = EXCLUDED.updated_at,
            mirrored_at = now(),
            source = EXCLUDED.source,
            raw_firestore_data = COALESCE(public.user_balance_snapshots_cache.raw_firestore_data, '{}'::jsonb)
              || EXCLUDED.raw_firestore_data
        `,
        [uid, SQL_DELETE_SOURCE, nowIso, actorUid, actorRole]
      );
      balanceSnapshotTombstoned = (insertBalanceResult.rowCount || 0) > 0;
    }

    const revokeResult = await client.query(
      `
        UPDATE public.app_sessions
        SET
          active = FALSE,
          ended_at = $2::timestamptz,
          ended_reason = $3::text,
          revoked_at = $2::timestamptz,
          updated_at = $2::timestamptz
        WHERE uid = $1::text
          AND active = TRUE
      `,
      [uid, nowIso, revokeReason]
    );
    const sessionsRevoked = revokeResult.rowCount || 0;

    await client.query('COMMIT');
    return {
      directoryTombstoned,
      balanceSnapshotTombstoned,
      sessionsRevoked,
      credentialsDeleted,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type SetUserPasswordInSqlInput = {
  uid: string;
  password: string;
  actorUid: string;
  actorRole: string;
  reason?: string;
};

export type SetUserPasswordInSqlResult = {
  sessionsRevoked: number;
  directoryUpdated: boolean;
};

export type SetUserStatusInSqlInput = {
  uid: string;
  status: UserDirectoryStatus;
  actorUid: string;
  actorRole: string;
  reason?: string;
  revokeSessionsOnDisable?: boolean;
};

export type SetUserStatusInSqlResult = {
  directoryUpdated: boolean;
  balanceSnapshotUpdated: boolean;
  sessionsRevoked: number;
};

export async function setUserPasswordInSql(
  input: SetUserPasswordInSqlInput
): Promise<SetUserPasswordInSqlResult> {
  const uid = cleanText(input.uid);
  const password = String(input.password || '');
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  const revokeReason = cleanText(input.reason) || 'password_reset';

  if (!uid || password.length < 6) {
    throw new Error('uid and password (min 6 chars) are required.');
  }
  if (!actorUid || !actorRole) {
    throw new Error('actorUid and actorRole are required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const hashed = await hashPassword(password);
  const now = new Date();
  const nowIso = now.toISOString();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `
        INSERT INTO public.user_credentials (
          uid,
          password_hash,
          password_algo,
          password_updated_at,
          migrated_from_firebase,
          must_reset,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4::timestamptz, FALSE, FALSE, $4::timestamptz, $4::timestamptz)
        ON CONFLICT (uid) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          password_algo = EXCLUDED.password_algo,
          password_updated_at = EXCLUDED.password_updated_at,
          migrated_from_firebase = FALSE,
          must_reset = FALSE,
          updated_at = EXCLUDED.updated_at
      `,
      [uid, hashed.hash, hashed.algo, nowIso]
    );

    const revokeResult = await client.query(
      `
        UPDATE public.app_sessions
        SET
          active = FALSE,
          ended_at = $2::timestamptz,
          ended_reason = $3,
          revoked_at = $2::timestamptz,
          updated_at = $2::timestamptz
        WHERE uid = $1
          AND active = TRUE
      `,
      [uid, nowIso, revokeReason]
    );
    const sessionsRevoked = revokeResult.rowCount || 0;

    const directoryResult = await client.query(
      `
        UPDATE public.players_cache
        SET
          password_updated_at = $2::timestamptz,
          password_updated_by_uid = $3,
          password_updated_by_role = $4,
          updated_at = $2::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'passwordUpdatedAt', $2::text,
            'passwordUpdatedByUid', $3,
            'passwordUpdatedByRole', $4
          )
        WHERE uid = $1
          AND deleted_at IS NULL
      `,
      [uid, nowIso, actorUid, actorRole]
    );
    const directoryUpdated = (directoryResult.rowCount || 0) > 0;

    await client.query('COMMIT');
    return { sessionsRevoked, directoryUpdated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateUserUsernameInSql(input: {
  uid: string;
  username: string;
  actorUid: string;
  actorRole: string;
}) {
  const uid = cleanText(input.uid);
  const username = cleanText(input.username).toLowerCase();
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  if (!uid || !username) {
    throw new Error('uid and username are required.');
  }
  if (!actorUid || !actorRole) {
    throw new Error('actorUid and actorRole are required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const email = `${username}@app.local`;
  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        UPDATE public.players_cache
        SET
          username = $2,
          email = $3,
          updated_at = $4::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'username', $2,
            'email', $3,
            'usernameUpdatedAt', $4::text,
            'usernameUpdatedByUid', $5,
            'usernameUpdatedByRole', $6
          )
        WHERE uid = $1 AND deleted_at IS NULL
      `,
      [uid, username, email, nowIso, actorUid, actorRole]
    );
    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          username = $2,
          email = $3,
          updated_at = $4::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'username', $2,
            'email', $3,
            'usernameUpdatedAt', $4::text,
            'usernameUpdatedByUid', $5,
            'usernameUpdatedByRole', $6
          )
        WHERE firebase_id = $1 AND deleted_at IS NULL
      `,
      [uid, username, email, nowIso, actorUid, actorRole]
    );
    await client.query('COMMIT');
    return { username, email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function setUserStatusInSql(
  input: SetUserStatusInSqlInput
): Promise<SetUserStatusInSqlResult> {
  const uid = cleanText(input.uid);
  const status = cleanText(input.status).toLowerCase();
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  const revokeReason = cleanText(input.reason) || 'status_disabled';
  const revokeSessionsOnDisable = input.revokeSessionsOnDisable ?? true;

  if (!uid || !isUserDirectoryStatus(status)) {
    throw new Error('uid and status (active|disabled) are required.');
  }
  if (!actorUid || !actorRole) {
    throw new Error('actorUid and actorRole are required.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const nowIso = new Date().toISOString();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const directoryResult = await client.query(
      `
        UPDATE public.players_cache
        SET
          status = $2,
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'status', $2,
            'statusUpdatedAt', $3::text,
            'statusUpdatedByUid', $4,
            'statusUpdatedByRole', $5
          )
        WHERE uid = $1
          AND deleted_at IS NULL
      `,
      [uid, status, nowIso, actorUid, actorRole]
    );
    const directoryUpdated = (directoryResult.rowCount || 0) > 0;

    const balanceSnapshotResult = await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          status = $2,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'status', $2,
            'statusUpdatedAt', $3::text,
            'statusUpdatedByUid', $4,
            'statusUpdatedByRole', $5
          )
        WHERE firebase_id = $1
          AND deleted_at IS NULL
      `,
      [uid, status, nowIso, actorUid, actorRole]
    );
    const balanceSnapshotUpdated = (balanceSnapshotResult.rowCount || 0) > 0;

    let sessionsRevoked = 0;
    if (status === 'disabled' && revokeSessionsOnDisable) {
      const revokeResult = await client.query(
        `
          UPDATE public.app_sessions
          SET
            active = FALSE,
            ended_at = $2::timestamptz,
            ended_reason = $3,
            revoked_at = $2::timestamptz,
            updated_at = $2::timestamptz
          WHERE uid = $1
            AND active = TRUE
        `,
        [uid, nowIso, revokeReason]
      );
      sessionsRevoked = revokeResult.rowCount || 0;
    }

    await client.query('COMMIT');
    return { directoryUpdated, balanceSnapshotUpdated, sessionsRevoked };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
