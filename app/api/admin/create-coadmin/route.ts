import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

export async function POST(request: Request) {
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

    if (!usernameSnap.empty) {
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

    await adminDb.collection('users').doc(authUser.uid).set({
      uid: authUser.uid,
      username,
      email,
      role: 'coadmin',
      createdBy,
      createdAt: new Date(),
      status: 'active',
    });
    void mirrorUserBalanceSnapshotById(authUser.uid, 'appbeg_create_coadmin');

    return NextResponse.json({
      success: true,
      uid: authUser.uid,
      message: 'Co-admin created.',
    });
  } catch (err: unknown) {
    console.error(err);

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create co-admin.' },
      { status: 500 }
    );
  }
}
