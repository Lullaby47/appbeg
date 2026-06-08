import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  createUserDirectoryInSql,
  isActiveUsernameTakenInSql,
} from '@/lib/sql/userDirectoryWrite';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

async function rollbackFirebaseUser(uid: string) {
  try {
    await adminAuth.deleteUser(uid);
  } catch {
    // Best-effort cleanup.
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let createdAuthUid: string | null = null;
  let firebaseCreateOk = false;

  try {
    const auth = await requireApiUser(request, ['admin']);
    if ('response' in auth) return auth.response;

    const body = await request.json();

    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const createdBy = auth.user.uid;

    if (!username) {
      return NextResponse.json(
        { error: 'Username is required.' },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters.' },
        { status: 400 }
      );
    }

    const usernameSnap = await adminDb
      .collection('users')
      .where('username', '==', username)
      .limit(1)
      .get();

    if (!usernameSnap.empty || (await isActiveUsernameTakenInSql(username))) {
      return NextResponse.json(
        { error: 'Username already exists.' },
        { status: 409 }
      );
    }

    const email = makeHiddenEmail(username);

    const authUser = await adminAuth.createUser({
      email,
      password,
      displayName: username,
      disabled: false,
    });
    createdAuthUid = authUser.uid;
    firebaseCreateOk = true;

    const firestoreUser = {
      uid: authUser.uid,
      username,
      email,
      role: 'coadmin',
      createdBy,
      createdAt: new Date(),
      status: 'active',
    };

    try {
      await createUserDirectoryInSql({
        uid: authUser.uid,
        username,
        email,
        role: 'coadmin',
        status: 'active',
        createdBy,
        password,
        rawData: firestoreUser,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
      });
    } catch (error) {
      await rollbackFirebaseUser(authUser.uid);
      createdAuthUid = null;
      console.info('[USER_DIRECTORY_SQL]', {
        action: 'create_user',
        route: 'create_coadmin',
        uid: authUser.uid,
        role: 'coadmin',
        actorUid: auth.user.uid,
        sql_ok: false,
        firebase_create_ok: firebaseCreateOk,
        firestore_mirror_ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    let firestoreMirrorOk = false;
    try {
      await adminDb.collection('users').doc(authUser.uid).set(firestoreUser);
      firestoreMirrorOk = true;
      void mirrorUserBalanceSnapshotById(authUser.uid, 'appbeg_create_coadmin');
    } catch (error) {
      console.warn('[USER_DIRECTORY_SQL] firestore mirror failed', {
        action: 'create_user',
        route: 'create_coadmin',
        uid: authUser.uid,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    createdAuthUid = null;

    console.info('[USER_DIRECTORY_SQL]', {
      action: 'create_user',
      route: 'create_coadmin',
      uid: authUser.uid,
      role: 'coadmin',
      actorUid: auth.user.uid,
      sql_ok: true,
      firebase_create_ok: firebaseCreateOk,
      firestore_mirror_ok: firestoreMirrorOk,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      success: true,
      uid: authUser.uid,
      message: 'Co-admin created.',
      sqlOk: true,
      firebaseMirrorOk: firebaseCreateOk,
      firestoreMirrorOk,
    });
  } catch (err: unknown) {
    if (createdAuthUid) {
      await rollbackFirebaseUser(createdAuthUid);
    }
    console.error(err);

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create co-admin.' },
      { status: 500 }
    );
  }
}
