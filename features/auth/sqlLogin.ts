'use client';

import { storeAppSessionLocal } from '@/features/auth/appSession';
import {
  getOrCreatePlayerDeviceId,
  storeLocalPlayerSessionId,
} from '@/features/auth/playerSession';
import { isSqlPlayerLoginEnabled } from '@/features/auth/sqlPlayerLoginFlags';
import { seedSessionUserCache } from '@/features/auth/sessionUser';

export { isSqlPlayerLoginEnabled } from '@/features/auth/sqlPlayerLoginFlags';

export type SqlLoginSuccess = {
  ok: true;
  sessionId: string;
  uid: string;
  role: string;
  coadminUid: string | null;
  username: string;
  expiresAt: string;
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
  return process.env.NEXT_PUBLIC_SQL_LOGIN_FIRST === '1';
}

export async function attemptSqlLogin(input: {
  username: string;
  password: string;
  deviceId?: string;
}): Promise<SqlLoginResult> {
  const username = String(input.username || '').trim().toLowerCase();
  const password = String(input.password || '');
  const deviceId = String(input.deviceId || getOrCreatePlayerDeviceId() || '').trim() || undefined;

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

    if (payload.ok && payload.sessionId && payload.uid && payload.role) {
      storeAppSessionLocal(payload.sessionId, String(payload.expiresAt || ''));
      if (payload.role === 'player' && payload.playerSessionId) {
        getOrCreatePlayerDeviceId();
        const canonicalSessionId = String(
          payload.playerSessionId || (payload as { canonicalSessionId?: string }).canonicalSessionId || ''
        ).trim();
        if (canonicalSessionId) {
          storeLocalPlayerSessionId(canonicalSessionId);
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
