import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

function isAuthUserNotFound(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const maybe = error as { code?: string };
  return maybe.code === 'auth/user-not-found';
}

async function ensureAuthUserDeleted(uid: string, email?: string | null) {
  try {
    await adminAuth.deleteUser(uid);
    return;
  } catch (error) {
    if (!isAuthUserNotFound(error)) {
      throw error;
    }
  }

  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) {
    return;
  }

  try {
    const userByEmail = await adminAuth.getUserByEmail(cleanEmail);
    await adminAuth.deleteUser(userByEmail.uid);
  } catch (error) {
    if (!isAuthUserNotFound(error)) {
      throw error;
    }
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const uid = String(body.uid || '');
    const deletedByUid = body.deletedByUid ? String(body.deletedByUid) : null;
    const permanent = Boolean(body.permanent);

    if (!uid) {
      return NextResponse.json(
        { error: 'User uid is required.' },
        { status: 400 }
      );
    }

    const userRef = adminDb.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return NextResponse.json(
        { error: 'User not found in Firestore.' },
        { status: 404 }
      );
    }

    const userData = userSnap.data();

    if (userData?.role === 'admin') {
      return NextResponse.json(
        { error: 'Admin cannot be deleted here.' },
        { status: 403 }
      );
    }

    if (userData?.role === 'player' && !permanent) {
      await adminDb.collection('deletedPlayers').doc(uid).set({
        ...userData,
        uid,
        role: 'player',
        deletedAt: new Date().toISOString(),
        deletedByUid,
      });
    }

    await ensureAuthUserDeleted(uid, userData?.email);
    await userRef.delete();

    return NextResponse.json({
      success: true,
      message:
        userData?.role === 'player' && !permanent
          ? 'Player archived and deleted from active users.'
          : 'User deleted from Auth and Firestore.',
    });
  } catch (err: any) {
    console.error(err);

    return NextResponse.json(
      { error: err.message || 'Failed to delete user.' },
      { status: 500 }
    );
  }
}