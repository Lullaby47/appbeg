import type { DocumentData } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import { assertValidGameUsername } from '@/lib/games/gameUsernameRule';
import {
  isAuthoritySqlWriteEnabled,
  logAuthorityFirestoreFallbackBlocked,
} from '@/lib/server/authoritySqlWrite';
import { lookupUserDirectoryFromSql } from '@/lib/sql/authorityLookup';
import { mirrorPlayerById } from '@/lib/sql/playersCache';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  isActiveUsernameTakenInSql,
  setUserPasswordInSql,
  updateUserUsernameInSql,
} from '@/lib/sql/userDirectoryWrite';
import { deactivateGameUsername, recordGameUsername } from '@/lib/sql/usernameRegistry';

export const runtime = 'nodejs';

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

async function recordPlayerLoginUsernameChange(input: {
  previousUsername: string;
  newUsername: string;
  playerUid: string;
  coadminUid: string;
}) {
  try {
    await deactivateGameUsername({
      username: input.previousUsername,
      playerUid: input.playerUid,
      reason: 'replaced',
    });
  } catch (error) {
    console.warn('[PLAYER_LOGIN_USERNAME_REGISTRY] deactivate failed after Firebase username change', {
      username: input.previousUsername,
      playerUid: input.playerUid,
      error,
    });
  }

  try {
    await recordGameUsername({
      username: input.newUsername,
      game: 'player_login',
      playerUid: input.playerUid,
      coadminUid: input.coadminUid,
      source: 'appbeg',
    });
  } catch (error) {
    console.warn('[PLAYER_LOGIN_USERNAME_REGISTRY] record failed after Firebase username change', {
      username: input.newUsername,
      playerUid: input.playerUid,
      coadminUid: input.coadminUid,
      error,
    });
  }
}

/**
 * Coadmin-only: set a new password and/or login username for a staff, carer, or player
 * that belongs to the calling coadmin.
 */
async function mirrorFirebaseAuthUpdate(
  targetUid: string,
  authUpdate: { password?: string; email?: string; displayName?: string }
) {
  if (Object.keys(authUpdate).length === 0) {
    return true;
  }
  try {
    await adminAuth.updateUser(targetUid, authUpdate);
    return true;
  } catch (error) {
    console.warn('[USER_DIRECTORY_SQL] firebase mirror failed', {
      action: 'password_reset',
      route: 'coadmin_reset_worker_credentials',
      uid: targetUid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const auth = await requireApiUser(request, ['coadmin']);
    if ('response' in auth) {
      return auth.response;
    }
    const callerUid = auth.user.uid;
    console.info('[COADMIN_RESET_WORKER_CREDENTIALS_AUTH]', {
      auth_path: auth.authPath,
      uid: callerUid,
      app_session_used: auth.authPath.startsWith('app_session'),
    });

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
        ? String(newUsernameRaw).trim()
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

    const authoritySql = isAuthoritySqlWriteEnabled();
    const targetRef = adminDb.collection('users').doc(targetUid);
    let target: Record<string, unknown>;
    if (authoritySql) {
      const sqlUser = await lookupUserDirectoryFromSql(targetUid);
      if (!sqlUser) {
        return NextResponse.json({ error: 'User not found.' }, { status: 404 });
      }
      target = {
        role: sqlUser.role,
        username: sqlUser.username,
        coadminUid: sqlUser.coadminUid,
        createdBy: sqlUser.createdBy,
      };
    } else {
      const targetSnap = await targetRef.get();
      if (!targetSnap.exists) {
        return NextResponse.json({ error: 'User not found.' }, { status: 404 });
      }
      target = (targetSnap.data() || {}) as Record<string, unknown>;
    }
    const role = String(target.role || '');

    if (role !== 'staff' && role !== 'carer' && role !== 'player') {
      return NextResponse.json(
        { error: 'Can only update staff, carer, or player accounts.' },
        { status: 403 }
      );
    }
    if (!workerBelongsToCoadmin(target, callerUid)) {
      return NextResponse.json(
        { error: 'This worker is not under your co-admin account.' },
        { status: 403 }
      );
    }

    if (role === 'carer' && newPassword) {
      return NextResponse.json(
        { error: 'Carer password must be set by admin approval flow.' },
        { status: 403 }
      );
    }

    const currentUsername = String(target.username || '').trim();
    let newUsername: string | undefined =
      newUsernameInput && role !== 'player' ? newUsernameInput.toLowerCase() : newUsernameInput;
    if (newUsername && newUsername === currentUsername) {
      newUsername = undefined;
    }

    if (newUsername !== undefined) {
      if (!newUsername) {
        return NextResponse.json({ error: 'Username cannot be empty.' }, { status: 400 });
      }
      if (role === 'player') {
        assertValidGameUsername(newUsername);
      }
      if (authoritySql) {
        if (await isActiveUsernameTakenInSql(newUsername)) {
          const currentUsername = cleanText(target.username).toLowerCase();
          if (currentUsername !== newUsername) {
            return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 });
          }
        }
      } else {
        const taken = await adminDb
          .collection('users')
          .where('username', '==', newUsername)
          .limit(1)
          .get();
        if (!taken.empty && taken.docs[0].id !== targetUid) {
          return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 });
        }
      }
    }

    let firebaseMirrorOk = true;
    let sessionsRevoked = 0;
    let directoryUpdated = false;

    if (newPassword && role === 'staff') {
      try {
        const sqlResult = await setUserPasswordInSql({
          uid: targetUid,
          password: newPassword,
          actorUid: callerUid,
          actorRole: auth.user.role,
          reason: 'password_reset',
        });
        sessionsRevoked = sqlResult.sessionsRevoked;
        directoryUpdated = sqlResult.directoryUpdated;
      } catch (error) {
        console.info('[USER_DIRECTORY_SQL]', {
          action: 'password_reset',
          route: 'coadmin_reset_worker_credentials',
          uid: targetUid,
          actorUid: callerUid,
          sql_ok: false,
          firebase_mirror_ok: false,
          sessions_revoked: 0,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          { error: error instanceof Error ? error.message : 'Password update failed.' },
          { status: 500 }
        );
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
      firebaseMirrorOk = await mirrorFirebaseAuthUpdate(targetUid, authUpdate);
    }

    if (newPassword && role === 'staff') {
      console.info('[USER_DIRECTORY_SQL]', {
        action: 'password_reset',
        route: 'coadmin_reset_worker_credentials',
        uid: targetUid,
        actorUid: callerUid,
        sql_ok: true,
        firebase_mirror_ok: firebaseMirrorOk,
        sessions_revoked: sessionsRevoked,
        directory_updated: directoryUpdated,
        durationMs: Date.now() - startedAt,
      });
    }

    if (newUsername) {
      if (authoritySql) {
        await updateUserUsernameInSql({
          uid: targetUid,
          username: newUsername,
          actorUid: callerUid,
          actorRole: auth.user.role,
        });
        logAuthorityFirestoreFallbackBlocked(
          '/api/coadmin/reset-worker-credentials',
          'users.update_username',
          { uid: targetUid }
        );
      } else {
        await targetRef.update({
          username: newUsername,
          email: makeHiddenEmail(newUsername),
        });
      }
      if (role === 'player') {
        await recordPlayerLoginUsernameChange({
          previousUsername: currentUsername,
          newUsername,
          playerUid: targetUid,
          coadminUid: callerUid,
        });
      }
    }
    if (role === 'player') {
      void mirrorPlayerById(targetUid, 'appbeg_reset_worker_credentials');
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
