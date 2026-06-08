import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import { setUserPasswordInSql } from '@/lib/sql/userDirectoryWrite';

type AllowedRole = 'admin' | 'staff' | 'coadmin';

function isAllowedRole(role: string): role is AllowedRole {
  return role === 'admin' || role === 'staff' || role === 'coadmin';
}

async function mirrorFirebasePassword(targetUid: string, newPassword: string) {
  try {
    await adminAuth.updateUser(targetUid, { password: newPassword });
    return true;
  } catch (error) {
    console.warn('[USER_DIRECTORY_SQL] firebase mirror failed', {
      action: 'password_reset',
      route: 'admin_reset_user_password',
      uid: targetUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const auth = await requireApiUser(request, ['admin']);
    if ('response' in auth) {
      return auth.response;
    }
    console.info('[ADMIN_RESET_USER_PASSWORD_AUTH]', {
      auth_path: auth.authPath,
      uid: auth.user.uid,
      app_session_used: auth.authPath.startsWith('app_session'),
    });

    const body = (await request.json()) as {
      targetUid?: string;
      newPassword?: string;
    };
    const targetUid = String(body.targetUid || '').trim();
    const newPassword = String(body.newPassword || '');
    if (!targetUid) {
      return NextResponse.json({ error: 'targetUid is required.' }, { status: 400 });
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
    }

    const targetSnap = await adminDb.collection('users').doc(targetUid).get();
    if (!targetSnap.exists) {
      return NextResponse.json({ error: 'Target user not found.' }, { status: 404 });
    }
    const targetRole = String(targetSnap.data()?.role || '').toLowerCase();
    if (!isAllowedRole(targetRole)) {
      return NextResponse.json(
        { error: 'Admin can only reset admin, staff, or coadmin password.' },
        { status: 403 }
      );
    }

    let sqlResult: Awaited<ReturnType<typeof setUserPasswordInSql>>;
    try {
      sqlResult = await setUserPasswordInSql({
        uid: targetUid,
        password: newPassword,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
        reason: 'password_reset',
      });
    } catch (error) {
      console.info('[USER_DIRECTORY_SQL]', {
        action: 'password_reset',
        route: 'admin_reset_user_password',
        uid: targetUid,
        actorUid: auth.user.uid,
        sql_ok: false,
        firebase_mirror_ok: false,
        sessions_revoked: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      const message = error instanceof Error ? error.message : 'Password reset failed.';
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const firebaseMirrorOk = await mirrorFirebasePassword(targetUid, newPassword);

    console.info('[USER_DIRECTORY_SQL]', {
      action: 'password_reset',
      route: 'admin_reset_user_password',
      uid: targetUid,
      actorUid: auth.user.uid,
      sql_ok: true,
      firebase_mirror_ok: firebaseMirrorOk,
      sessions_revoked: sqlResult.sessionsRevoked,
      directory_updated: sqlResult.directoryUpdated,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      success: true,
      message: 'Password reset successfully.',
      firebaseMirrorOk,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Password reset failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
