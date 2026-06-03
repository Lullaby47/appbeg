import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  apiError,
  belongsToScope,
  requireApiUser,
  scopedCoadminUid,
} from '@/lib/firebase/apiAuth';
import { deactivateGameUsername } from '@/lib/sql/usernameRegistry';

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

    const targetRole = String(userData?.role || '').toLowerCase();
    if (auth.user.role !== 'admin') {
      if (targetRole === 'coadmin') {
        return apiError('Only admin can delete coadmin accounts.', 403);
      }
      const coadminUid = scopedCoadminUid(auth.user);
      if (!coadminUid || !belongsToScope(userData || {}, coadminUid)) {
        return apiError('Target user is outside your coadmin scope.', 403);
      }
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
    if (userData?.role === 'player') {
      await deactivatePlayerGameUsernames(uid, permanent ? 'deleted' : 'archived');
    }

    return NextResponse.json({
      success: true,
      message:
        userData?.role === 'player' && !permanent
          ? 'Player archived and deleted from active users.'
          : 'User deleted from Auth and Firestore.',
    });
  } catch (err: unknown) {
    console.error(err);

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete user.' },
      { status: 500 }
    );
  }
}

async function deactivatePlayerGameUsernames(playerUid: string, reason: 'deleted' | 'archived') {
  try {
    const snapshot = await adminDb
      .collection('playerGameLogins')
      .where('playerUid', '==', playerUid)
      .get();
    const usernames = Array.from(
      new Set(
        snapshot.docs
          .map((docSnap) =>
            String((docSnap.data() as { gameUsername?: string }).gameUsername || '').trim()
          )
          .filter(Boolean)
      )
    );

    await Promise.all(
      usernames.map((username) =>
        deactivateGameUsername({ username, playerUid, reason }).catch((error) => {
          console.warn('[DELETE_USER] username registry deactivate failed', {
            username,
            playerUid,
            reason,
            error,
          });
        })
      )
    );
  } catch (error) {
    console.warn('[DELETE_USER] failed to load player usernames for registry deactivation', {
      playerUid,
      reason,
      error,
    });
  }
}
