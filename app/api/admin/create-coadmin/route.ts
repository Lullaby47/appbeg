import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const createdBy = body.createdBy ? String(body.createdBy).trim() : null;

    if (!createdBy) {
      return NextResponse.json(
        { error: 'Creator is required.' },
        { status: 400 }
      );
    }

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

    const creatorSnap = await adminDb.collection('users').doc(createdBy).get();

    if (!creatorSnap.exists) {
      return NextResponse.json(
        { error: 'Creator account not found.' },
        { status: 403 }
      );
    }

    const creatorData = creatorSnap.data() as {
      role?: string;
      createdBy?: string | null;
    };
    const creatorRole = String(creatorData.role || '').toLowerCase();

    // Permission rule:
    // - Admin can create coadmin.
    // - Staff is allowed only when that staff was created by an admin.
    // - Coadmin and coadmin-created staff are not allowed.
    if (creatorRole === 'coadmin') {
      return NextResponse.json(
        { error: 'Coadmin-created staff cannot create coadmin accounts.' },
        { status: 403 }
      );
    }

    if (creatorRole === 'staff') {
      const creatorParentUid = creatorData.createdBy ? String(creatorData.createdBy) : '';

      if (!creatorParentUid) {
        return NextResponse.json(
          { error: 'Staff creator scope is invalid.' },
          { status: 403 }
        );
      }

      const parentSnap = await adminDb.collection('users').doc(creatorParentUid).get();

      if (!parentSnap.exists) {
        return NextResponse.json(
          { error: 'Staff creator owner not found.' },
          { status: 403 }
        );
      }

      const parentData = parentSnap.data() as { role?: string };
      const parentRole = String(parentData.role || '').toLowerCase();

      if (parentRole !== 'admin') {
        return NextResponse.json(
          { error: 'Coadmin-created staff cannot create coadmin accounts.' },
          { status: 403 }
        );
      }
    }

    if (creatorRole !== 'admin' && creatorRole !== 'staff') {
      return NextResponse.json(
        { error: 'You are not allowed to create coadmin accounts.' },
        { status: 403 }
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

    return NextResponse.json({
      success: true,
      uid: authUser.uid,
      message: 'Co-admin created.',
    });
  } catch (err: any) {
    console.error(err);

    return NextResponse.json(
      { error: err.message || 'Failed to create co-admin.' },
      { status: 500 }
    );
  }
}