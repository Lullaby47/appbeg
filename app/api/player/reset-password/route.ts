import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';

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
    await adminDb.collection('users').doc(auth.user.uid).set(
      {
        passwordUpdatedAt: FieldValue.serverTimestamp(),
        passwordUpdatedByUid: auth.user.uid,
        passwordUpdatedByRole: 'player',
      },
      { merge: true }
    );

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
