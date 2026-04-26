import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

type UserStatus = 'active' | 'disabled';

function isValidStatus(status: string): status is UserStatus {
  return status === 'active' || status === 'disabled';
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const uid = String(body.uid || '').trim();
    const status = String(body.status || '').trim().toLowerCase();

    if (!uid) {
      return NextResponse.json({ error: 'User uid is required.' }, { status: 400 });
    }

    if (!isValidStatus(status)) {
      return NextResponse.json({ error: 'Invalid status value.' }, { status: 400 });
    }

    const userRef = adminDb.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }

    const userData = userSnap.data();

    if (userData?.role === 'admin') {
      return NextResponse.json(
        { error: 'Admin status cannot be changed here.' },
        { status: 403 }
      );
    }

    const isDisabled = status === 'disabled';
    const role = String(userData?.role || '');
    const isPlayer = role === 'player';

    if (isPlayer) {
      // App-level "blocked" for players: keep Firebase Auth enabled so they can
      // sign in, message staff, and request unblocking. (Old records may have
      // disabled=true; re-enable on every update.)
      await adminAuth.updateUser(uid, { disabled: false });
    } else {
      await adminAuth.updateUser(uid, {
        disabled: isDisabled,
      });
    }

    await userRef.update({
      status,
    });

    return NextResponse.json({
      success: true,
      message: `User ${isDisabled ? 'blocked' : 'unblocked'} successfully.`,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to update user status.' },
      { status: 500 }
    );
  }
}
