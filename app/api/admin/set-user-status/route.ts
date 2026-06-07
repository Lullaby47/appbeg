import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  apiError,
  belongsToScope,
  requireApiUser,
  scopedCoadminUid,
} from '@/lib/firebase/apiAuth';
import { mirrorPlayerById } from '@/lib/sql/playersCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

type UserStatus = 'active' | 'disabled';

function isValidStatus(status: string): status is UserStatus {
  return status === 'active' || status === 'disabled';
}

export async function POST(request: Request) {
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
    if (isPlayer) {
      void mirrorPlayerById(uid, 'appbeg_set_user_status');
    }
    void mirrorUserBalanceSnapshotById(uid, 'appbeg_set_user_status');

    return NextResponse.json({
      success: true,
      message: `User ${isDisabled ? 'blocked' : 'unblocked'} successfully.`,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update user status.' },
      { status: 500 }
    );
  }
}
