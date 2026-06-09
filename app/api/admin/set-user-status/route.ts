import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  apiError,
  belongsToScope,
  requireApiUser,
  scopedCoadminUid,
} from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthorityFirestoreFallbackBlocked,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { lookupUserDirectoryFromSql } from '@/lib/sql/authorityLookup';
import { mirrorPlayerById } from '@/lib/sql/playersCache';
import { setUserStatusInSql } from '@/lib/sql/userDirectoryWrite';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

type UserStatus = 'active' | 'disabled';

function isValidStatus(status: string): status is UserStatus {
  return status === 'active' || status === 'disabled';
}

async function mirrorFirebaseAuthStatus(uid: string, isPlayer: boolean, isDisabled: boolean) {
  try {
    if (isPlayer) {
      await adminAuth.updateUser(uid, { disabled: false });
    } else {
      await adminAuth.updateUser(uid, { disabled: isDisabled });
    }
    return true;
  } catch (error) {
    console.warn('[USER_DIRECTORY_SQL] firebase auth mirror failed', {
      action: 'set_status',
      uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function mirrorFirestoreStatus(
  userRef: FirebaseFirestore.DocumentReference,
  status: UserStatus
) {
  try {
    await userRef.update({ status });
    return true;
  } catch (error) {
    console.warn('[USER_DIRECTORY_SQL] firestore mirror failed', {
      action: 'set_status',
      status,
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
    const status = String(body.status || '').trim().toLowerCase();

    if (!uid) {
      return NextResponse.json({ error: 'User uid is required.' }, { status: 400 });
    }

    if (!isValidStatus(status)) {
      return NextResponse.json({ error: 'Invalid status value.' }, { status: 400 });
    }

    const authoritySql = isAuthoritySqlWriteEnabled();
    let userData: Record<string, unknown> | undefined;
    let userRef: FirebaseFirestore.DocumentReference | null = null;

    if (authoritySql) {
      const sqlUser = await lookupUserDirectoryFromSql(uid);
      if (!sqlUser) {
        return NextResponse.json({ error: 'User not found.' }, { status: 404 });
      }
      userData = {
        role: sqlUser.role,
        status: sqlUser.status,
        coadminUid: sqlUser.coadminUid,
        createdBy: sqlUser.createdBy,
      };
    } else {
      userRef = adminDb.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        return NextResponse.json({ error: 'User not found.' }, { status: 404 });
      }
      userData = userSnap.data();
    }

    if (userData?.role === 'admin') {
      return NextResponse.json(
        { error: 'Admin status cannot be changed here.' },
        { status: 403 }
      );
    }

    const targetRole = String(userData?.role || '').toLowerCase();
    if (auth.user.role !== 'admin') {
      if (targetRole === 'coadmin') {
        return apiError('Only admin can change coadmin status.', 403);
      }
      const coadminUid = scopedCoadminUid(auth.user);
      if (!coadminUid || !belongsToScope(userData || {}, coadminUid)) {
        return apiError('Target user is outside your coadmin scope.', 403);
      }
    }

    const isDisabled = status === 'disabled';
    const role = String(userData?.role || '');
    const isPlayer = role === 'player';

    let sqlResult: Awaited<ReturnType<typeof setUserStatusInSql>>;
    try {
      sqlResult = await setUserStatusInSql({
        uid,
        status,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
        reason: 'status_disabled',
        revokeSessionsOnDisable: !isPlayer,
      });
    } catch (error) {
      console.info('[USER_DIRECTORY_SQL]', {
        action: 'set_status',
        uid,
        status,
        actorUid: auth.user.uid,
        sql_ok: false,
        firebase_mirror_ok: false,
        firestore_mirror_ok: false,
        sessions_revoked: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to update user status.' },
        { status: 500 }
      );
    }

    const firebaseMirrorOk = await mirrorFirebaseAuthStatus(uid, isPlayer, isDisabled);
    let firestoreMirrorOk = false;
    if (authoritySql) {
      logAuthorityFirestoreFallbackBlocked('/api/admin/set-user-status', 'mirror_firestore_status', {
        uid,
        status,
      });
      logAuthoritySqlWrite('/api/admin/set-user-status', {
        uid,
        status,
        sessions_revoked: sqlResult.sessionsRevoked,
      });
    } else if (userRef) {
      firestoreMirrorOk = await mirrorFirestoreStatus(userRef, status);
      if (firestoreMirrorOk) {
        if (isPlayer) {
          void mirrorPlayerById(uid, 'appbeg_set_user_status');
        }
        void mirrorUserBalanceSnapshotById(uid, 'appbeg_set_user_status');
      }
    }

    console.info('[USER_DIRECTORY_SQL]', {
      action: 'set_status',
      uid,
      status,
      actorUid: auth.user.uid,
      authority_sql_write: authoritySql,
      sql_ok: true,
      firebase_mirror_ok: firebaseMirrorOk,
      firestore_mirror_ok: firestoreMirrorOk,
      sessions_revoked: sqlResult.sessionsRevoked,
      directory_updated: sqlResult.directoryUpdated,
      balance_snapshot_updated: sqlResult.balanceSnapshotUpdated,
      player_preserve_sessions: isPlayer,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      success: true,
      message: `User ${isDisabled ? 'blocked' : 'unblocked'} successfully.`,
      sqlOk: true,
      authority: authoritySql ? 'sql' : 'firestore_mirror',
      firebaseMirrorOk,
      firestoreMirrorOk,
      sessionsRevoked: sqlResult.sessionsRevoked,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update user status.' },
      { status: 500 }
    );
  }
}
