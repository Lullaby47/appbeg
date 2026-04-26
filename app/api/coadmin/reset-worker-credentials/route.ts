import type { DocumentData } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

function workerBelongsToCoadmin(
  data: DocumentData,
  coadminUid: string
) {
  if (String(data.coadminUid) === coadminUid) {
    return true;
  }
  if (String(data.createdBy) === coadminUid) {
    return true;
  }
  return false;
}

/**
 * Coadmin-only: set a new password and/or login username for a staff or carer
 * that belongs to the calling coadmin.
 */
export async function POST(request: Request) {
  try {
    const header = request.headers.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const idToken = match?.[1];
    if (!idToken) {
      return NextResponse.json({ error: 'Missing or invalid authorization.' }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(idToken);
    const callerUid = decoded.uid;
    const callerSnap = await adminDb.collection('users').doc(callerUid).get();

    if (!callerSnap.exists) {
      return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
    }
    if (String(callerSnap.data()?.role) !== 'coadmin') {
      return NextResponse.json(
        { error: 'Only coadmin can perform this action.' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const targetUid = String(body.targetUid || '').trim();
    const newPasswordRaw = body.newPassword;
    const newUsernameRaw = body.newUsername;

    const newPassword =
      newPasswordRaw != null && String(newPasswordRaw) !== ''
        ? String(newPasswordRaw)
        : undefined;
    const newUsernameInput =
      newUsernameRaw != null && String(newUsernameRaw) !== ''
        ? String(newUsernameRaw).trim().toLowerCase()
        : undefined;

    if (!targetUid) {
      return NextResponse.json({ error: 'targetUid is required.' }, { status: 400 });
    }
    if (!newPassword && !newUsernameInput) {
      return NextResponse.json(
        { error: 'Provide newPassword and/or newUsername.' },
        { status: 400 }
      );
    }

    if (newPassword && newPassword.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters.' },
        { status: 400 }
      );
    }

    const targetRef = adminDb.collection('users').doc(targetUid);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }
    const target = targetSnap.data()!;
    const role = String(target.role || '');

    if (role !== 'staff' && role !== 'carer') {
      return NextResponse.json(
        { error: 'Can only update staff or carer accounts.' },
        { status: 403 }
      );
    }
    if (!workerBelongsToCoadmin(target, callerUid)) {
      return NextResponse.json(
        { error: 'This worker is not under your co-admin account.' },
        { status: 403 }
      );
    }

    const currentUsername = String(target.username || '').trim().toLowerCase();
    let newUsername: string | undefined = newUsernameInput;
    if (newUsername && newUsername === currentUsername) {
      newUsername = undefined;
    }

    if (newUsername !== undefined) {
      if (!newUsername) {
        return NextResponse.json({ error: 'Username cannot be empty.' }, { status: 400 });
      }
      const taken = await adminDb
        .collection('users')
        .where('username', '==', newUsername)
        .limit(1)
        .get();
      if (!taken.empty && taken.docs[0].id !== targetUid) {
        return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 });
      }
    }

    const authUpdate: { password?: string; email?: string; displayName?: string } = {};
    if (newPassword) {
      authUpdate.password = newPassword;
    }
    if (newUsername) {
      const email = makeHiddenEmail(newUsername);
      authUpdate.email = email;
      authUpdate.displayName = newUsername;
    }

    if (Object.keys(authUpdate).length > 0) {
      await adminAuth.updateUser(targetUid, authUpdate);
    }
    if (newUsername) {
      await targetRef.update({
        username: newUsername,
        email: makeHiddenEmail(newUsername),
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Sign-in details updated.',
      username: (newUsername ?? currentUsername) || currentUsername,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Update failed.' },
      { status: 500 }
    );
  }
}
