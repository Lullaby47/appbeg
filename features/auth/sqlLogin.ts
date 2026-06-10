'use client';

import { storeAppSessionLocal } from '@/features/auth/appSession';
import {
  clearPlayerSessionBeforeLogin,
  getOrCreatePlayerDeviceId,
  logPlayerSessionStorageWrite,
  storePlayerLoginSessionPair,
} from '@/features/auth/playerSession';
import { isSqlPlayerLoginEnabled } from '@/features/auth/sqlPlayerLoginFlags';
import { seedSessionUserCache } from '@/features/auth/sessionUser';
import { isPublicSqlLoginFirstEnabled } from '@/lib/client/sqlPublicFlags';

export { isSqlPlayerLoginEnabled } from '@/features/auth/sqlPlayerLoginFlags';

export type SqlLoginSuccess = {
  ok: true;
  sessionId?: string;
  uid: string;
  role: string;
  coadminUid: string | null;
  username: string;
  expiresAt?: string;
  bootstrapExpected?: boolean;
  playerSessionId?: string;
  playerSessionSource?: 'sql';
  firestoreMirrorOk?: boolean;
};

export type SqlLoginFailureReason =
  | 'credentials_missing'
  | 'invalid_credentials'
  | 'server_unavailable'
  | 'network_error'
  | 'player_session_not_sql_ready';

export type SqlLoginFailure = {
  ok: false;
  reason: SqlLoginFailureReason;
  fallbackToFirebase: boolean;
};

export type SqlLoginResult = SqlLoginSuccess | SqlLoginFailure;

export function isSqlLoginFirstEnabled() {
  return isPublicSqlLoginFirstEnabled();
}

export async function attemptSqlLogin(input: {
  username: string;
  password: string;
  deviceId?: string;
}): Promise<SqlLoginResult> {
  const username = String(input.username || '').trim().toLowerCase();
  const password = String(input.password || '');
  const deviceId = String(input.deviceId || getOrCreatePlayerDeviceId() || '').trim() || undefined;

  if (typeof window !== 'undefined') {
    clearPlayerSessionBeforeLogin('sql_login_attempt');
  }

  try {
    const response = await fetch('/api/auth/login-sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        deviceId,
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      authenticated?: boolean;
      bootstrapExpected?: boolean;
      reason?: SqlLoginFailureReason;
      fallbackToFirebase?: boolean;
      sessionId?: string;
      uid?: string;
      role?: string;
      coadminUid?: string | null;
      username?: string;
      status?: string | null;
      expiresAt?: string;
      playerSessionId?: string;
      playerSessionSource?: 'sql';
      firestoreMirrorOk?: boolean;
    };

    if (payload.ok && payload.uid && payload.role) {
      if (payload.bootstrapExpected) {
        console.info('[SQL_AUTH_LOGIN] client_bootstrap_expected', {
          uid: payload.uid,
          role: payload.role,
          sqlPlayerLoginEnabled: isSqlPlayerLoginEnabled(),
        });
        console.info('[LOGIN_SQL_DECISION]', {
          uid: payload.uid,
          role: payload.role,
          authenticated: true,
          playerSessionRequired: true,
          playerSessionExists: false,
          bootstrapExpected: true,
          decision: 'bootstrap_expected',
          reason: 'client_awaiting_firebase_bootstrap',
        });
        return {
          ok: true,
          uid: payload.uid,
          role: payload.role,
          coadminUid: payload.coadminUid ?? null,
          username: String(payload.username || username),
          bootstrapExpected: true,
        };
      }

      if (!payload.sessionId) {
        const reason =
          response.status >= 500 ? 'server_unavailable' : 'invalid_credentials';
        return {
          ok: false,
          reason,
          fallbackToFirebase: payload.fallbackToFirebase === true,
        };
      }

      if (payload.role === 'player' && payload.playerSessionId) {
        getOrCreatePlayerDeviceId();
        storePlayerLoginSessionPair({
          appSessionId: payload.sessionId,
          appSessionExpiresAt: String(payload.expiresAt || ''),
          playerSessionId: String(
            payload.playerSessionId ||
              (payload as { canonicalSessionId?: string }).canonicalSessionId ||
              ''
          ).trim(),
          phase: 'sql_login',
          reason: 'login_sql_ok',
        });
      } else {
        storeAppSessionLocal(payload.sessionId, String(payload.expiresAt || ''));
        if (payload.role === 'player') {
          logPlayerSessionStorageWrite({
            source: 'sql_login_app_session_only',
            appSessionIdPrefix: String(payload.sessionId || '').slice(0, 8) || null,
            playerSessionIdPrefix: null,
            keysWritten: ['appbeg:appSessionId', 'appbeg:appSessionExpiresAt'],
            role: 'player',
          });
        }
      }
      seedSessionUserCache(
        {
          uid: payload.uid,
          role: payload.role,
          coadminUid: payload.coadminUid ?? null,
          username: payload.username || username,
          status: payload.status ?? null,
          expiresAt: payload.expiresAt ?? null,
        },
        'sql_login'
      );
      console.info('[SQL_AUTH_LOGIN] client_ok', {
        uid: payload.uid,
        role: payload.role,
        sessionId: payload.sessionId,
        playerSessionId: payload.playerSessionId || null,
        playerSessionSource: payload.playerSessionSource || null,
        firestoreMirrorOk: payload.firestoreMirrorOk ?? null,
        sqlPlayerLoginEnabled: isSqlPlayerLoginEnabled(),
      });
      return {
        ok: true,
        sessionId: payload.sessionId,
        uid: payload.uid,
        role: payload.role,
        coadminUid: payload.coadminUid ?? null,
        username: String(payload.username || username),
        expiresAt: String(payload.expiresAt || ''),
        ...(payload.role === 'player' && payload.playerSessionId
          ? {
              playerSessionId: payload.playerSessionId,
              playerSessionSource: payload.playerSessionSource,
              firestoreMirrorOk: payload.firestoreMirrorOk,
            }
          : {}),
      };
    }

    const reason = payload.reason || (response.status >= 500 ? 'server_unavailable' : 'invalid_credentials');
    const fallbackToFirebase =
      payload.fallbackToFirebase === true ||
      reason === 'credentials_missing' ||
      reason === 'server_unavailable' ||
      reason === 'player_session_not_sql_ready';

    console.info('[SQL_AUTH_LOGIN] client_failed', {
      reason,
      fallbackToFirebase,
      status: response.status,
    });

    return {
      ok: false,
      reason,
      fallbackToFirebase,
    };
  } catch (error) {
    console.warn('[SQL_AUTH_LOGIN] client_failed', {
      reason: 'network_error',
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      reason: 'network_error',
      fallbackToFirebase: true,
    };
  }
}
