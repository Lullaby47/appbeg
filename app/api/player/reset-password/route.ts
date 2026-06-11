import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { setUserPasswordInSql } from '@/lib/sql/userDirectoryWrite';
import { mirrorPlayerById } from '@/lib/sql/playersCache';

export const runtime = 'nodejs';

type Body = {
  newPassword?: unknown;
  confirmPassword?: unknown;
};

const MIN_PLAYER_PASSWORD_LENGTH = 6;

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const newPassword = String(body.newPassword || '');
    const confirmPassword = String(body.confirmPassword || '');

    if (!newPassword || !confirmPassword) {
      return apiError('New password and confirm password are required.', 400);
    }
    if (newPassword !== confirmPassword) {
      return apiError('New password and confirm password must match.', 400);
    }
    if (newPassword.length < MIN_PLAYER_PASSWORD_LENGTH) {
      return apiError(
        `Password must be at least ${MIN_PLAYER_PASSWORD_LENGTH} characters.`,
        400
      );
    }

    await adminAuth.updateUser(auth.user.uid, { password: newPassword });

    if (isAuthoritySqlWriteEnabled()) {
      await setUserPasswordInSql({
        uid: auth.user.uid,
        password: newPassword,
        actorUid: auth.user.uid,
        actorRole: 'player',
        reason: 'player_self_reset',
      });
      logAuthoritySqlWrite('/api/player/reset-password', { uid: auth.user.uid });
      return NextResponse.json({
        authority: 'sql',
        success: true,
        username: auth.user.username,
      });
    }

    await adminDb.collection('users').doc(auth.user.uid).set(
      {
        passwordUpdatedAt: FieldValue.serverTimestamp(),
        passwordUpdatedByUid: auth.user.uid,
        passwordUpdatedByRole: 'player',
      },
      { merge: true }
    );
    void mirrorPlayerById(auth.user.uid, 'appbeg_player_reset_password');

    return NextResponse.json({
      success: true,
      username: auth.user.username,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reset password.';
    const status = /not authenticated|authorization|token/i.test(message)
      ? 401
      : /forbidden/i.test(message)
      ? 403
      : /required|match|password|characters/i.test(message)
      ? 400
      : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
