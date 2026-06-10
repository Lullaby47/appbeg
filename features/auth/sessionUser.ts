'use client';

import { isValidRole } from '@/lib/auth/roles';

const APP_SESSION_ID_KEY = 'appbeg:appSessionId';
const APP_SESSION_EXPIRES_AT_KEY = 'appbeg:appSessionExpiresAt';

export type SessionUser = {
  uid: string;
  role: string;
  username?: string | null;
  coadminUid?: string | null;
  status?: string | null;
  expiresAt?: string | null;
};

let cachedUser: SessionUser | null = null;
let cachedSessionId: string | null = null;
let inflightPromise: Promise<SessionUser | null> | null = null;

function readLocalAppSessionId() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(APP_SESSION_ID_KEY) || '';
}

function clearLocalAppSessionStorage() {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.removeItem(APP_SESSION_ID_KEY);
  window.localStorage.removeItem(APP_SESSION_EXPIRES_AT_KEY);
}

function clearExpiredAppSessionStorage() {
  if (typeof window === 'undefined') {
    return;
  }
  const expiresAt = window.localStorage.getItem(APP_SESSION_EXPIRES_AT_KEY);
  if (!expiresAt) {
    return;
  }
  if (new Date(expiresAt).getTime() <= Date.now()) {
    clearLocalAppSessionStorage();
  }
}

function isAppSessionRoleAllowed(status: string | null | undefined, role: string) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const normalizedRole = String(role || '').trim().toLowerCase();
  const isActive = normalizedStatus === 'active';
  const isBlockedPlayer = normalizedStatus === 'disabled' && normalizedRole === 'player';
  return isActive || isBlockedPlayer;
}

function getSessionRequestHeaders(): Record<string, string> {
  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    return {};
  }
  return { 'X-App-Session-Id': sessionId };
}

function mapPayloadToSessionUser(payload: {
  uid?: string;
  role?: string;
  coadminUid?: string | null;
  username?: string;
  status?: string | null;
  expiresAt?: string;
}): SessionUser | null {
  if (!payload.uid || !payload.role || !isValidRole(payload.role)) {
    return null;
  }
  if (!isAppSessionRoleAllowed(payload.status ?? null, payload.role)) {
    return null;
  }
  return {
    uid: payload.uid,
    role: payload.role,
    coadminUid: payload.coadminUid ?? null,
    username: String(payload.username || ''),
    status: payload.status ?? null,
    expiresAt: String(payload.expiresAt || ''),
  };
}

async function fetchSessionUserFromApi(): Promise<SessionUser | null> {
  clearExpiredAppSessionStorage();

  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    clearCachedSessionUser('missing_session_id');
    return null;
  }

  try {
    const response = await fetch('/api/auth/session/me', {
      method: 'GET',
      headers: getSessionRequestHeaders(),
      cache: 'no-store',
    });

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      reason?: string;
      uid?: string;
      role?: string;
      coadminUid?: string | null;
      username?: string;
      status?: string | null;
      expiresAt?: string;
    };

    if (!response.ok || !payload.ok) {
      const meReason = payload.reason || `http_${response.status}`;
      console.info('[APP_SESSION_ME_CLIENT_STATE]', {
        route: typeof window !== 'undefined' ? window.location.pathname || '' : '',
        hasAppSessionId: Boolean(sessionId),
        appSessionIdPrefix: sessionId ? sessionId.slice(0, 8) : null,
        role: payload.role ?? cachedUser?.role ?? null,
        visibilityState:
          typeof document !== 'undefined' ? document.visibilityState : null,
        reason: meReason,
      });
      if (
        payload.reason === 'invalid_or_expired' ||
        payload.reason === 'account_not_active' ||
        payload.reason === 'uid_mismatch'
      ) {
        clearLocalAppSessionStorage();
      }
      clearCachedSessionUser(payload.reason || 'fetch_invalid');
      return null;
    }

    const user = mapPayloadToSessionUser(payload);
    if (!user) {
      clearLocalAppSessionStorage();
      clearCachedSessionUser('payload_invalid');
      return null;
    }

    cachedUser = user;
    cachedSessionId = sessionId;
    return user;
  } catch {
    clearCachedSessionUser('fetch_failed');
    return null;
  }
}

export function getCachedSessionUser(): SessionUser | null {
  clearExpiredAppSessionStorage();

  const sessionId = readLocalAppSessionId();
  if (!sessionId || !cachedUser || cachedSessionId !== sessionId) {
    return null;
  }

  console.info('[SESSION_USER_CACHE] hit', {
    uid: cachedUser.uid,
    role: cachedUser.role,
  });
  return cachedUser;
}

export type SessionUserCacheSeedReason = 'sql_login' | 'bootstrap' | 'manual';

export function seedSessionUserCache(user: SessionUser, reason: SessionUserCacheSeedReason) {
  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    console.info('[SESSION_USER_CACHE] seed_skipped', {
      reason,
      detail: 'missing_local_app_session_id',
      uid: user.uid,
      role: user.role,
    });
    return false;
  }

  cachedUser = user;
  cachedSessionId = sessionId;
  console.info('[SESSION_USER_CACHE] seeded', {
    reason,
    uid: user.uid,
    role: user.role,
    sessionIdPrefix: sessionId.slice(0, 8),
  });
  return true;
}

/** @deprecated Prefer seedSessionUserCache with an explicit reason. */
export function setCachedSessionUser(user: SessionUser) {
  seedSessionUserCache(user, 'manual');
}

export function clearCachedSessionUser(reason: string) {
  cachedUser = null;
  cachedSessionId = null;
  inflightPromise = null;
  console.info('[SESSION_USER_CACHE] clear', { reason });
}

export function getSessionUserOnce(): Promise<SessionUser | null> {
  clearExpiredAppSessionStorage();

  const sessionId = readLocalAppSessionId();
  if (!sessionId) {
    clearCachedSessionUser('missing_session_id');
    return Promise.resolve(null);
  }

  if (cachedUser && cachedSessionId === sessionId) {
    console.info('[SESSION_USER_CACHE] hit', {
      uid: cachedUser.uid,
      role: cachedUser.role,
    });
    return Promise.resolve(cachedUser);
  }

  if (cachedSessionId && cachedSessionId !== sessionId) {
    clearCachedSessionUser('session_id_changed');
  }

  if (inflightPromise) {
    console.info('[SESSION_USER_CACHE] inflight');
    return inflightPromise;
  }

  console.info('[SESSION_USER_CACHE] miss', { reason: 'fetch_required' });
  inflightPromise = fetchSessionUserFromApi().finally(() => {
    inflightPromise = null;
  });
  return inflightPromise;
}
