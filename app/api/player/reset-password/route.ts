import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { apiError, requirePlayerApiUser } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { isAppbegSqlOnlyMode, isAuthFirestoreFallbackAllowed } from '@/lib/server/appbegSqlOnlyMode';
import { logPlayerApiAuthOk } from '@/lib/server/playerApiAuthLog';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import { mapResetPasswordSqlError, setUserPasswordInSql } from '@/lib/sql/userDirectoryWrite';
import { mirrorPlayerById } from '@/lib/sql/playersCache';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/reset-password';

type Body = {
  newPassword?: unknown;
  confirmPassword?: unknown;
};

const MIN_PLAYER_PASSWORD_LENGTH = 6;

function mapResetPasswordRouteError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : 'Failed to reset password.';
  const mappedSqlMessage = mapResetPasswordSqlError(error);
  if (mappedSqlMessage !== rawMessage) {
    return mappedSqlMessage;
  }
  if (/not authenticated|authorization|token|session/i.test(rawMessage)) {
    return 'Session expired. Please log in again.';
  }
  if (/could not determine data type of parameter|parameter \$\d+/i.test(rawMessage)) {
    return 'Password reset failed. Please try again.';
  }
  return rawMessage;
}

export async function POST(request: Request) {
  const headerSessions = sessionIdsFromRequest(request);
  try {
    console.info('[RESET_PASSWORD_API_START]', {
      route: ROUTE,
      ...headerSessions,
      canonicalSessionId: headerSessions.player_session_id,
    });
    console.info('[RESET_PASSWORD_AUTH_BEGIN]', {
      route: ROUTE,
      authHelper: 'requirePlayerApiUser',
      ...headerSessions,
      canonicalSessionId: headerSessions.player_session_id,
    });

    const auth = await requirePlayerApiUser(request);
    if ('response' in auth) {
      console.info('[RESET_PASSWORD_AUTH_FAILED]', {
        route: ROUTE,
        uid: null,
        role: null,
        playerUid: null,
        ...headerSessions,
        auth_path: auth.timing.auth_path,
        reason: 'requirePlayerApiUser_denied',
        status: auth.response.status,
      });
      logRouteSessionValidation(ROUTE, {
        ok: false,
        ...headerSessions,
        canonical_session_id: headerSessions.player_session_id,
        validates: 'player_session_sql',
        auth_path: auth.timing.auth_path,
        session_source: auth.timing.session_source,
      });
      return auth.response;
    }

    console.info('[RESET_PASSWORD_AUTH_OK]', {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      playerUid: auth.user.uid,
      ...headerSessions,
      canonicalSessionId: auth.timing.request_session_id ?? headerSessions.player_session_id,
      activeSessionId: auth.timing.active_session_id ?? null,
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      status: 200,
    });
    logRouteSessionValidation(ROUTE, {
      ok: true,
      ...headerSessions,
      canonical_session_id: auth.timing.request_session_id ?? headerSessions.player_session_id,
      validates: 'player_session_sql',
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      uid: auth.user.uid,
    });
    logPlayerApiAuthOk(request, {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      authPath: auth.authPath,
    });

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

    const sqlOnly = isAppbegSqlOnlyMode();
    const authoritySql = isAuthoritySqlWriteEnabled();

    if (authoritySql || sqlOnly) {
      const sqlResult = await setUserPasswordInSql({
        uid: auth.user.uid,
        password: newPassword,
        actorUid: auth.user.uid,
        actorRole: 'player',
        reason: 'player_self_reset',
      });
      logAuthoritySqlWrite(ROUTE, {
        uid: auth.user.uid,
        sessionsRevoked: sqlResult.sessionsRevoked,
        directoryUpdated: sqlResult.directoryUpdated,
      });

      if (sqlOnly) {
        console.info('[SQL_NO_FIREBASE_PASSWORD_RESET]', {
          route: ROUTE,
          uid: auth.user.uid,
          reason: 'appbeg_sql_only_mode',
        });
      } else if (isAuthFirestoreFallbackAllowed()) {
        try {
          await adminAuth.updateUser(auth.user.uid, { password: newPassword });
        } catch (error) {
          console.info('[RESET_PASSWORD_FIREBASE_MIRROR_SKIPPED]', {
            route: ROUTE,
            uid: auth.user.uid,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return NextResponse.json({
        authority: 'sql',
        success: true,
        username: auth.user.username,
      });
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
    void mirrorPlayerById(auth.user.uid, 'appbeg_player_reset_password');

    return NextResponse.json({
      success: true,
      username: auth.user.username,
      authority: 'firestore',
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Failed to reset password.';
    const message = mapResetPasswordRouteError(error);
    console.info('[RESET_PASSWORD_SQL_ERROR]', {
      route: ROUTE,
      error: rawMessage,
      userMessage: message,
    });
    const status = /session expired|not authenticated|authorization|token|session/i.test(message)
      ? 401
      : /forbidden/i.test(message)
        ? 403
        : /required|match|password|characters/i.test(message)
          ? 400
          : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
