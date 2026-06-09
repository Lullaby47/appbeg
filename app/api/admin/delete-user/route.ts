import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  apiError,
  belongsToScope,
  requireApiUser,
  scopedCoadminUid,
} from '@/lib/firebase/apiAuth';
import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
} from '@/lib/sql/playerMirrorCommon';
import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import { deactivateGameUsername } from '@/lib/sql/usernameRegistry';
import { mirrorDeletedPlayerById } from '@/lib/sql/deletedPlayersCache';
import { deleteUserDirectoryInSql } from '@/lib/sql/userDirectoryWrite';

type DeleteUserSource = 'firestore' | 'sql';

type ResolvedDeleteTarget = {
  sourceUsed: DeleteUserSource;
  userData: Record<string, unknown>;
  firestoreExists: boolean;
  email: string | null;
};

function parseRawFirestoreData(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

async function resolveDeleteTargetFromSql(uid: string): Promise<ResolvedDeleteTarget | null> {
  const db = getPlayerMirrorPool();
  if (!db) {
    return null;
  }

  const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
    db,
    `
      SELECT
        uid,
        username,
        email,
        role,
        status,
        created_by,
        coadmin_uid,
        coin,
        cash,
        raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [uid]
  );

  if (!rows.length) {
    return null;
  }

  const row = rows[0];
  const raw = parseRawFirestoreData(row.raw_firestore_data);
  const username = cleanText(row.username) || cleanText(raw.username);
  const email =
    cleanText(row.email) ||
    cleanText(raw.email) ||
    (username ? `${username}@app.local` : '');

  const userData: Record<string, unknown> = {
    ...raw,
    uid: cleanText(row.uid) || uid,
    username,
    email,
    role: cleanText(row.role) || cleanText(raw.role),
    status: cleanText(row.status) || cleanText(raw.status) || 'active',
    createdBy: cleanText(row.created_by) || cleanText(raw.createdBy) || null,
    coadminUid: cleanText(row.coadmin_uid) || cleanText(raw.coadminUid) || null,
    coin: row.coin ?? raw.coin,
    cash: row.cash ?? raw.cash,
  };

  return {
    sourceUsed: 'sql',
    userData,
    firestoreExists: false,
    email: email || null,
  };
}

async function resolveDeleteTarget(uid: string): Promise<ResolvedDeleteTarget | null> {
  if (isAuthoritySqlWriteEnabled()) {
    return resolveDeleteTargetFromSql(uid);
  }

  const userRef = adminDb.collection('users').doc(uid);
  const userSnap = await userRef.get();

  if (userSnap.exists) {
    const userData = (userSnap.data() || {}) as Record<string, unknown>;
    return {
      sourceUsed: 'firestore',
      userData,
      firestoreExists: true,
      email: cleanText(userData.email) || null,
    };
  }

  return resolveDeleteTargetFromSql(uid);
}

function isAuthUserNotFound(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const maybe = error as { code?: string };
  return maybe.code === 'auth/user-not-found';
}

async function mirrorFirebaseUserDeleted(uid: string, email?: string | null) {
  try {
    await adminAuth.deleteUser(uid);
    return true;
  } catch (error) {
    if (!isAuthUserNotFound(error)) {
      console.warn('[USER_DIRECTORY_SQL] firebase auth delete failed', {
        action: 'delete_user',
        uid,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) {
    return true;
  }

  try {
    const userByEmail = await adminAuth.getUserByEmail(cleanEmail);
    await adminAuth.deleteUser(userByEmail.uid);
    return true;
  } catch (error) {
    if (isAuthUserNotFound(error)) {
      return true;
    }
    console.warn('[USER_DIRECTORY_SQL] firebase auth delete by email failed', {
      action: 'delete_user',
      uid,
      email: cleanEmail,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function mirrorFirestoreUserDeleted(
  userRef: FirebaseFirestore.DocumentReference
) {
  try {
    await userRef.delete();
    return true;
  } catch (error) {
    console.warn('[USER_DIRECTORY_SQL] firestore delete failed', {
      action: 'delete_user',
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin']);
    if ('response' in auth) return auth.response;

    const body = await request.json();
    const uid = String(body.uid || '').trim();
    const deletedByUid = auth.user.uid;
    const permanent = auth.user.role === 'admin' && Boolean(body.permanent);

    if (!uid) {
      return NextResponse.json(
        { error: 'User uid is required.' },
        { status: 400 }
      );
    }

    const resolved = await resolveDeleteTarget(uid);
    if (!resolved) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }

    const { userData, sourceUsed, firestoreExists, email } = resolved;
    const userRef = adminDb.collection('users').doc(uid);

    if (String(userData.role || '').toLowerCase() === 'admin') {
      return NextResponse.json(
        { error: 'Admin cannot be deleted here.' },
        { status: 403 }
      );
    }

    const targetRole = String(userData.role || '').toLowerCase();
    if (auth.user.role !== 'admin') {
      if (targetRole === 'coadmin') {
        return apiError('Only admin can delete coadmin accounts.', 403);
      }
      const coadminUid = scopedCoadminUid(auth.user);
      if (!coadminUid || !belongsToScope(userData, coadminUid)) {
        return apiError('Target user is outside your coadmin scope.', 403);
      }
    }

    const isPlayer = targetRole === 'player';

    if (isPlayer && !permanent) {
      if (!isAuthoritySqlWriteEnabled()) {
        await adminDb.collection('deletedPlayers').doc(uid).set({
          ...userData,
          uid,
          role: 'player',
          deletedAt: new Date().toISOString(),
          deletedByUid,
        });
      }
      void mirrorDeletedPlayerById(uid, 'appbeg_delete_user');
    }

    let sqlResult: Awaited<ReturnType<typeof deleteUserDirectoryInSql>> | null = null;
    let sqlOk = false;

    if (!isPlayer) {
      try {
        sqlResult = await deleteUserDirectoryInSql({
          uid,
          actorUid: auth.user.uid,
          actorRole: auth.user.role,
          reason: 'user_deleted',
          hardDeleteCredentials: true,
        });
        sqlOk = true;
      } catch (error) {
        console.info('[USER_DIRECTORY_SQL]', {
          action: 'delete_user',
          source_used: sourceUsed,
          uid,
          role: targetRole,
          actorUid: auth.user.uid,
          sql_ok: false,
          firebase_mirror_ok: false,
          firestore_mirror_ok: false,
          sessions_revoked: 0,
          credentials_deleted: 0,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          { error: error instanceof Error ? error.message : 'Failed to delete user.' },
          { status: 500 }
        );
      }
    } else {
      try {
        sqlResult = await deleteUserDirectoryInSql({
          uid,
          actorUid: auth.user.uid,
          actorRole: auth.user.role,
          reason: isPlayer && !permanent ? 'player_archived' : 'user_deleted',
          hardDeleteCredentials: true,
        });
        sqlOk = true;
      } catch (error) {
        console.warn('[USER_DIRECTORY_SQL] player sql cleanup failed', {
          action: 'delete_user',
          source_used: sourceUsed,
          uid,
          role: targetRole,
          actorUid: auth.user.uid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const firebaseMirrorOk = await mirrorFirebaseUserDeleted(uid, email);
    const firestoreMirrorOk =
      isAuthoritySqlWriteEnabled() || !firestoreExists
        ? true
        : await mirrorFirestoreUserDeleted(userRef);

    if (isPlayer) {
      await deactivatePlayerLoginUsername({
        username: String(userData.username || '').trim(),
        playerUid: uid,
        reason: permanent ? 'deleted' : 'archived',
      });
    }

    console.info('[USER_DIRECTORY_SQL]', {
      action: 'delete_user',
      source_used: sourceUsed,
      uid,
      role: targetRole,
      actorUid: auth.user.uid,
      sql_ok: sqlOk,
      firebase_mirror_ok: firebaseMirrorOk,
      firestore_mirror_ok: firestoreMirrorOk,
      sessions_revoked: sqlResult?.sessionsRevoked ?? 0,
      credentials_deleted: sqlResult?.credentialsDeleted ?? 0,
      directory_tombstoned: sqlResult?.directoryTombstoned ?? false,
      balance_snapshot_tombstoned: sqlResult?.balanceSnapshotTombstoned ?? false,
      player_archive: isPlayer && !permanent,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      success: true,
      message:
        isPlayer && !permanent
          ? 'Player archived and deleted from active users.'
          : 'User deleted from Auth and Firestore.',
      sqlOk,
      firebaseMirrorOk,
      firestoreMirrorOk,
      sessionsRevoked: sqlResult?.sessionsRevoked ?? 0,
      credentialsDeleted: sqlResult?.credentialsDeleted ?? 0,
      sourceUsed,
    });
  } catch (err: unknown) {
    console.error(err);

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete user.' },
      { status: 500 }
    );
  }
}

async function deactivatePlayerLoginUsername(input: {
  username: string;
  playerUid: string;
  reason: 'deleted' | 'archived';
}) {
  if (!input.username) {
    return;
  }
  try {
    await deactivateGameUsername({
      username: input.username,
      playerUid: input.playerUid,
      reason: input.reason,
    });
  } catch (error) {
    console.warn('[PLAYER_LOGIN_USERNAME_REGISTRY] deactivate failed after Firebase player delete', {
      username: input.username,
      playerUid: input.playerUid,
      reason: input.reason,
      error,
    });
  }
}
