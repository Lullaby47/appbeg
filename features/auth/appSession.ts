'use client';

import { auth } from '@/lib/firebase/client';
import { isValidRole, type UserRole } from '@/lib/auth/roles';
import {
  getOrCreatePlayerDeviceId,
  storePlayerLoginSessionPair,
} from '@/features/auth/playerSession';
import {
  clearCachedSessionUser,
  getCachedSessionUser,
  getSessionUserOnce,
  seedSessionUserCache,
} from '@/features/auth/sessionUser';

export const APP_SESSION_ID_KEY = 'appbeg:appSessionId';
export const APP_SESSION_EXPIRES_AT_KEY = 'appbeg:appSessionExpiresAt';
export const IMPERSONATOR_SESSION_ID_KEY = 'appbeg:impersonatorSessionId';

type BootstrapResponse = {
  sessionId?: string;
  playerSessionId?: string;
  canonicalSessionId?: string;
  uid?: string;
  role?: string;
  coadminUid?: string | null;
  username?: string | null;
  status?: string | null;
  expiresAt?: string;
  error?: string;
};

export function getLocalAppSessionId() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(APP_SESSION_ID_KEY) || '';
}

export function getAppSessionRequestHeaders(): Record<string, string> {
  const sessionId = getLocalAppSessionId();
  if (!sessionId) {
    return {};
  }
  return { 'X-App-Session-Id': sessionId };
}

export type AppSessionUser = {
  uid: string;
  role: UserRole;
  coadminUid: string | null;
  username: string;
  status: string | null;
  expiresAt: string;
};

function mapCachedAppSessionUser(
  user: NonNullable<ReturnType<typeof getCachedSessionUser>>
): AppSessionUser {
  return {
    uid: user.uid,
    role: user.role as UserRole,
    coadminUid: user.coadminUid ?? null,
    username: String(user.username || ''),
    status: user.status ?? null,
    expiresAt: String(user.expiresAt || ''),
  };
}

export async function getCurrentAppSessionUser(): Promise<AppSessionUser | null> {
  clearExpiredAppSessionLocal();

  if (!getLocalAppSessionId()) {
    return null;
  }

  const cached = getCachedSessionUser();
  if (cached && isValidRole(cached.role)) {
    return mapCachedAppSessionUser(cached);
  }

  const user = await getSessionUserOnce();
  if (!user || !isValidRole(user.role)) {
    return null;
  }

  return mapCachedAppSessionUser(user);
}

let ensureAppSessionPromise: Promise<string | null> | null = null;

function clearExpiredAppSessionLocal() {
  if (typeof window === 'undefined') {
    return;
  }
  const expiresAt = window.localStorage.getItem(APP_SESSION_EXPIRES_AT_KEY);
  if (!expiresAt) {
    return;
  }
  if (new Date(expiresAt).getTime() <= Date.now()) {
    clearAppSessionLocal();
  }
}

export async function ensureAppSessionBootstrapped(): Promise<string | null> {
  clearExpiredAppSessionLocal();

  const existing = getLocalAppSessionId();
  if (existing) {
    return existing;
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    return null;
  }

  if (!ensureAppSessionPromise) {
    ensureAppSessionPromise = bootstrapAppSessionAfterFirebaseLogin()
      .then((result) => result?.sessionId || getLocalAppSessionId() || null)
      .finally(() => {
        ensureAppSessionPromise = null;
      });
  }

  return ensureAppSessionPromise;
}

export function clearAppSessionLocal() {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.removeItem(APP_SESSION_ID_KEY);
  window.localStorage.removeItem(APP_SESSION_EXPIRES_AT_KEY);
  clearCachedSessionUser('local_session_cleared');
}

export function storeAppSessionLocal(sessionId: string, expiresAt: string) {
  if (typeof window === 'undefined') {
    return;
  }
  const previousSessionId = getLocalAppSessionId();
  window.localStorage.setItem(APP_SESSION_ID_KEY, sessionId);
  if (expiresAt) {
    window.localStorage.setItem(APP_SESSION_EXPIRES_AT_KEY, expiresAt);
  }
  if (previousSessionId && previousSessionId !== sessionId) {
    clearCachedSessionUser('session_id_replaced');
  }
}

export function storeImpersonatorSessionId(sessionId: string) {
  if (typeof window === 'undefined' || !sessionId) {
    return;
  }
  window.sessionStorage.setItem(IMPERSONATOR_SESSION_ID_KEY, sessionId);
}

export function startImpersonationSession(sessionId: string, expiresAt: string) {
  const currentSessionId = getLocalAppSessionId();
  if (currentSessionId) {
    storeImpersonatorSessionId(currentSessionId);
  }
  storeAppSessionLocal(sessionId, expiresAt);
  clearCachedSessionUser('impersonation_started');
}

export async function bootstrapAppSessionAfterFirebaseLogin(input?: {
  roleHint?: string;
  playerSessionId?: string;
}) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    return null;
  }

  const token = await currentUser.getIdToken();
  const roleHint = String(input?.roleHint || '').trim() || undefined;
  const playerSessionId = String(input?.playerSessionId || '').trim() || undefined;
  const deviceId = getOrCreatePlayerDeviceId() || undefined;

  const response = await fetch('/api/auth/session/bootstrap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      deviceId,
      playerSessionId,
      roleHint,
    }),
  });

  const payload = (await response.json()) as BootstrapResponse;
  if (!response.ok || !payload.sessionId) {
    console.info('[SQL_AUTH_BOOTSTRAP] client_failed', {
      status: response.status,
      error: payload.error || 'bootstrap_failed',
    });
    return null;
  }

  const canonicalSessionId = String(
    payload.canonicalSessionId || payload.playerSessionId || ''
  ).trim();
  if (payload.role === 'player' && canonicalSessionId) {
    storePlayerLoginSessionPair({
      appSessionId: payload.sessionId,
      appSessionExpiresAt: String(payload.expiresAt || ''),
      playerSessionId: canonicalSessionId,
      phase: 'firebase_bootstrap',
      reason: 'bootstrap_ok',
    });
  } else {
    storeAppSessionLocal(payload.sessionId, String(payload.expiresAt || ''));
  }
  if (payload.uid && payload.role && isValidRole(payload.role)) {
    seedSessionUserCache(
      {
        uid: payload.uid,
        role: payload.role,
        coadminUid: payload.coadminUid ?? null,
        username: payload.username ?? null,
        status: payload.status ?? null,
        expiresAt: payload.expiresAt ?? null,
      },
      'bootstrap'
    );
  }
  console.info('[SQL_AUTH_BOOTSTRAP] client_ok', {
    uid: payload.uid || null,
    role: payload.role || null,
    sessionId: payload.sessionId,
    appSessionId: payload.sessionId,
    playerSessionId: canonicalSessionId || null,
    canonicalSessionId: canonicalSessionId || null,
    expiresAt: payload.expiresAt || null,
  });
  return payload;
}

export async function revokeAppSessionOnLogout(reason = 'logout') {
  const { performSqlClientLogoutCleanup } = await import('@/lib/client/sqlLogoutCleanup');
  await performSqlClientLogoutCleanup(reason);
}
