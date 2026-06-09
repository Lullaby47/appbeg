'use client';

import { User, signOut } from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

import { getAppSessionRequestHeaders, getLocalAppSessionId } from '@/features/auth/appSession';
import { isSqlPlayerLoginEnabled } from '@/features/auth/sqlPlayerLoginFlags';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { logClientFirestoreSkipped, isClientSqlReadMode } from '@/lib/client/sqlReadMode';
import { auth, db } from '@/lib/firebase/client';

export const PLAYER_DEVICE_ID_KEY = 'appbeg:playerDeviceId';
export const PLAYER_SESSION_ID_KEY = 'appbeg:playerSessionId';
export const PLAYER_REPLACED_LOGIN_MESSAGE =
  'You were logged out because this account logged in on another device.';
export const PLAYER_SESSION_REPLACED_LOGIN_PATH = '/login?reason=session_replaced';

/** SQL app + player session pair from bootstrap (independent of NEXT_PUBLIC_SQL_PLAYER_LOGIN). */
export function isSqlPlayerAppSessionMode() {
  return Boolean(getLocalAppSessionId()) && Boolean(getLocalPlayerSessionId());
}

let forcedPlayerLogout = false;

const DEFAULT_PLAYER_SESSION_POLL_INTERVAL_MS = 12_000;
const PLAYER_SESSION_VERIFY_CACHE_TTL_MS = 8_000;
let activePlayerSessionPollStop: (() => void) | null = null;

type PlayerSessionVerifyCacheEntry = {
  expiresAt: number;
  localSessionId: string;
  result: PlayerSessionVerifyResult;
};

let playerSessionVerifyCache: PlayerSessionVerifyCacheEntry | null = null;
let verifyActivePlayerSessionInflight: Promise<PlayerSessionVerifyResult> | null = null;

function makeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getPlayerSessionDevice(deviceId: string) {
  if (typeof window === 'undefined') {
    return { deviceId };
  }

  return {
    deviceId,
    userAgent: window.navigator.userAgent,
    platform: window.navigator.platform,
  };
}

export function getOrCreatePlayerDeviceId() {
  if (typeof window === 'undefined') {
    return '';
  }

  const existing = window.localStorage.getItem(PLAYER_DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }

  const next = makeId();
  window.localStorage.setItem(PLAYER_DEVICE_ID_KEY, next);
  return next;
}

export function getLocalPlayerSessionId() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(PLAYER_SESSION_ID_KEY) || '';
}

export function discardStalePlayerSessionIdForRole(role: string, reason = 'non_player_role') {
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (normalizedRole === 'player') {
    return;
  }
  const existing = getLocalPlayerSessionId();
  if (!existing) {
    return;
  }
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(PLAYER_SESSION_ID_KEY);
  }
  invalidatePlayerSessionVerifyCache(reason);
  console.info('[PLAYER_SESSION_LOCAL] discarded_stale_id', {
    reason,
    role: normalizedRole,
    sessionIdPrefix: existing.slice(0, 8),
  });
}

export function storeLocalPlayerSessionId(sessionId: string) {
  forcedPlayerLogout = false;
  invalidatePlayerSessionVerifyCache('session_id_replaced');
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(PLAYER_SESSION_ID_KEY, sessionId);
}

export function invalidatePlayerSessionVerifyCache(reason = 'manual') {
  playerSessionVerifyCache = null;
  console.info('[PLAYER_SESSION_VERIFY_CACHE]', {
    hit: false,
    reason,
  });
}

function readPlayerSessionVerifyCache(localSessionId: string) {
  if (!playerSessionVerifyCache) {
    return null;
  }
  if (
    playerSessionVerifyCache.localSessionId !== localSessionId ||
    playerSessionVerifyCache.expiresAt <= Date.now()
  ) {
    playerSessionVerifyCache = null;
    return null;
  }
  return playerSessionVerifyCache.result;
}

function writePlayerSessionVerifyCache(
  localSessionId: string,
  result: PlayerSessionVerifyResult
) {
  if (!result.ok) {
    playerSessionVerifyCache = null;
    return;
  }
  playerSessionVerifyCache = {
    expiresAt: Date.now() + PLAYER_SESSION_VERIFY_CACHE_TTL_MS,
    localSessionId,
    result,
  };
}

export function seedPlayerSessionVerifyCache(result: PlayerSessionVerifyResult) {
  const localSessionId = getLocalPlayerSessionId();
  if (!localSessionId || !result.ok) {
    return;
  }
  writePlayerSessionVerifyCache(localSessionId, result);
}

export function resolvePlayerApiHeaderMode(headers: Record<string, string>) {
  const hasBearer = Boolean(headers.Authorization);
  const hasAppSession = Boolean(headers['X-App-Session-Id']);
  if (hasBearer && hasAppSession) {
    return 'mixed';
  }
  if (hasBearer) {
    return 'firebase';
  }
  return 'app_session';
}

async function buildPlayerSessionRequestHeaders(contentType = false) {
  const sessionId = getLocalPlayerSessionId();
  const sqlPlayerMode = isSqlPlayerAppSessionMode() && Boolean(sessionId);
  const headers: Record<string, string> = {
    ...getAppSessionRequestHeaders(),
  };
  if (contentType) {
    headers['Content-Type'] = 'application/json';
  }
  if (sessionId) {
    headers['X-Player-Session-Id'] = sessionId;
  }
  const currentUser = auth.currentUser;
  if (currentUser && !sqlPlayerMode) {
    headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
  }
  return headers;
}

export function isPlayerForcedLogout() {
  return forcedPlayerLogout;
}

export function clearPlayerBrowserState() {
  invalidatePlayerSessionVerifyCache('browser_state_cleared');
  if (typeof window === 'undefined') {
    return;
  }
  console.info('[SESSION_GUARD] clearing local session');
  const deviceId = window.localStorage.getItem(PLAYER_DEVICE_ID_KEY);
  window.localStorage.clear();
  window.sessionStorage.clear();
  if (deviceId) {
    window.localStorage.setItem(PLAYER_DEVICE_ID_KEY, deviceId);
  }
  window.dispatchEvent(new Event('appbeg:player-session-cleared'));
}

export function stopPlayerSessionStatusPolling() {
  activePlayerSessionPollStop?.();
  activePlayerSessionPollStop = null;
}

export type PlayerSessionStatusPollingOptions = {
  intervalMs?: number;
  onReplaced?: () => void;
  onInactive?: () => void;
  redirect?: (url: string) => void;
};

export function startPlayerSessionStatusPolling(
  options: PlayerSessionStatusPollingOptions = {}
) {
  stopPlayerSessionStatusPolling();

  if (typeof window === 'undefined') {
    return () => {};
  }

  const intervalMs = options.intervalMs ?? DEFAULT_PLAYER_SESSION_POLL_INTERVAL_MS;
  const sessionId = getLocalPlayerSessionId();
  if (!sessionId) {
    return () => {};
  }

  console.info('[PLAYER_SESSION_POLL]', {
    started: true,
    sessionId,
    intervalMs,
  });

  let stopped = false;
  let timeoutId: number | undefined;
  let inFlight = false;

  const stop = () => {
    stopped = true;
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (activePlayerSessionPollStop === stop) {
      activePlayerSessionPollStop = null;
    }
  };

  const scheduleNext = (delayMs: number) => {
    if (stopped) {
      return;
    }
    timeoutId = window.setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped) {
      return;
    }

    if (document.hidden) {
      scheduleNext(intervalMs);
      return;
    }

    if (inFlight || forcedPlayerLogout) {
      scheduleNext(intervalMs);
      return;
    }

    inFlight = true;
    const pollSessionId = getLocalPlayerSessionId();

    try {
      const status = await verifyActivePlayerSession({ forceRefresh: true });
      if (stopped) {
        return;
      }

      if (status.ok) {
        console.info('[PLAYER_SESSION_POLL]', {
          status: 'ok',
          sessionId: pollSessionId,
        });
        scheduleNext(intervalMs);
        return;
      }

      if (status.reason === 'session_replaced') {
        console.info('[PLAYER_SESSION_POLL]', {
          status: 'session_replaced',
          sessionId: pollSessionId,
          activeSessionId: status.activeSessionId || null,
        });
        stop();
        options.onReplaced?.();
        await forcePlayerSessionLogout({
          redirect: options.redirect,
          markSessionInactive: true,
        });
        return;
      }

      if (status.reason === 'session_inactive') {
        console.info('[PLAYER_SESSION_POLL]', {
          status: 'session_inactive',
          sessionId: pollSessionId,
        });
        stop();
        options.onInactive?.();
        await forcePlayerSessionLogout({
          redirect: options.redirect,
          markSessionInactive: true,
        });
        return;
      }

      console.info('[PLAYER_SESSION_POLL]', {
        status: 'error',
        sessionId: pollSessionId,
        reason: status.reason,
      });
      scheduleNext(intervalMs);
    } catch (error) {
      console.info('[PLAYER_SESSION_POLL]', {
        status: 'error',
        sessionId: pollSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleNext(intervalMs);
    } finally {
      inFlight = false;
    }
  };

  activePlayerSessionPollStop = stop;
  scheduleNext(intervalMs);

  return stop;
}

export async function forcePlayerSessionLogout(options?: {
  redirect?: (url: string) => void;
  markSessionInactive?: boolean;
}) {
  stopPlayerSessionStatusPolling();

  if (forcedPlayerLogout) {
    return;
  }
  forcedPlayerLogout = true;

  if (options?.markSessionInactive !== false) {
    await endLocalPlayerSession('replaced_by_new_login');
  }
  clearPlayerBrowserState();

  console.info('[SESSION_GUARD] firebase signOut start');
  try {
    await signOut(auth);
  } finally {
    console.info('[SESSION_GUARD] firebase signOut done');
  }

  console.info('[SESSION_GUARD] redirecting to login');
  if (options?.redirect) {
    options.redirect(PLAYER_SESSION_REPLACED_LOGIN_PATH);
  } else if (typeof window !== 'undefined') {
    window.location.replace(PLAYER_SESSION_REPLACED_LOGIN_PATH);
  }
}

export type PlayerSessionVerifyFailureReason =
  | 'missing_auth_user'
  | 'missing_local_session_id'
  | 'forced_logout_already_set'
  | 'not_player_app_session'
  | 'session_replaced'
  | 'session_inactive';

export type PlayerSessionVerifyResult =
  | { ok: true; source?: 'sql' | 'firestore_fallback' }
  | {
      ok: false;
      reason: PlayerSessionVerifyFailureReason;
      activeSessionId?: string | null;
      source?: 'sql' | 'firestore_fallback';
    };

async function verifyActivePlayerSessionViaApi(
  localSessionId: string
): Promise<PlayerSessionVerifyResult | null> {
  try {
    const response = await fetch('/api/auth/player-session/status', {
      method: 'GET',
      headers: {
        'X-Player-Session-Id': localSessionId,
        ...(await buildPlayerSessionRequestHeaders()),
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      reason?: string;
      activeSessionId?: string | null;
      source?: 'sql' | 'firestore_fallback';
    };

    if (payload.ok) {
      return {
        ok: true,
        source: payload.source === 'firestore_fallback' ? 'firestore_fallback' : 'sql',
      };
    }

    if (payload.reason === 'session_inactive') {
      return {
        ok: false,
        reason: 'session_inactive',
        activeSessionId: payload.activeSessionId || null,
        source: payload.source,
      };
    }

    if (payload.reason === 'session_replaced') {
      return {
        ok: false,
        reason: 'session_replaced',
        activeSessionId: payload.activeSessionId || null,
        source: payload.source,
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function verifyActivePlayerSessionViaFirestore(
  currentUser: User,
  localSessionId: string
): Promise<PlayerSessionVerifyResult> {
  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
  const activeSessionId = String(userSnap.data()?.activeSessionId || '').trim();
  if (!activeSessionId || activeSessionId !== localSessionId) {
    return {
      ok: false,
      reason: 'session_replaced',
      activeSessionId: activeSessionId || null,
      source: 'firestore_fallback',
    };
  }

  return { ok: true, source: 'firestore_fallback' };
}

async function resolveActivePlayerSession(
  options?: { forceRefresh?: boolean }
): Promise<PlayerSessionVerifyResult> {
  const appSessionUser = getCachedSessionUser();
  if (appSessionUser?.role && appSessionUser.role !== 'player') {
    return { ok: false, reason: 'not_player_app_session' };
  }

  const currentUser = auth.currentUser;
  const localSessionId = getLocalPlayerSessionId();
  const sqlPlayerMode = isSqlPlayerAppSessionMode();

  if (!localSessionId || forcedPlayerLogout) {
    return {
      ok: false,
      reason: !localSessionId ? 'missing_local_session_id' : 'forced_logout_already_set',
    };
  }

  if (!currentUser && !sqlPlayerMode) {
    return { ok: false, reason: 'missing_auth_user' };
  }

  if (!options?.forceRefresh) {
    const cached = readPlayerSessionVerifyCache(localSessionId);
    if (cached) {
      console.info('[PLAYER_SESSION_VERIFY_CACHE]', {
        hit: true,
        sessionIdPrefix: localSessionId.slice(0, 8),
      });
      return cached;
    }
    console.info('[PLAYER_SESSION_VERIFY_CACHE]', {
      hit: false,
      sessionIdPrefix: localSessionId.slice(0, 8),
    });
  }

  const apiResult = await verifyActivePlayerSessionViaApi(localSessionId);
  if (apiResult) {
    if (apiResult.ok) {
      writePlayerSessionVerifyCache(localSessionId, apiResult);
    } else {
      invalidatePlayerSessionVerifyCache('api_verify_failed');
    }
    return apiResult;
  }

  if (currentUser && !sqlPlayerMode) {
    const firestoreResult = await verifyActivePlayerSessionViaFirestore(
      currentUser,
      localSessionId
    );
    if (firestoreResult.ok) {
      writePlayerSessionVerifyCache(localSessionId, firestoreResult);
    } else {
      invalidatePlayerSessionVerifyCache('firestore_verify_failed');
    }
    return firestoreResult;
  }

  return { ok: false, reason: 'missing_auth_user' };
}

export async function verifyActivePlayerSession(options?: {
  forceRefresh?: boolean;
}): Promise<PlayerSessionVerifyResult> {
  if (options?.forceRefresh) {
    return resolveActivePlayerSession(options);
  }

  if (verifyActivePlayerSessionInflight) {
    console.info('[PLAYER_SESSION_VERIFY_CACHE]', {
      hit: false,
      reason: 'inflight_deduped',
    });
    return verifyActivePlayerSessionInflight;
  }

  verifyActivePlayerSessionInflight = resolveActivePlayerSession(options);
  try {
    return await verifyActivePlayerSessionInflight;
  } finally {
    verifyActivePlayerSessionInflight = null;
  }
}

export async function assertActivePlayerSession() {
  const currentUser = auth.currentUser;
  const localSessionId = getLocalPlayerSessionId();
  const result = await verifyActivePlayerSession();

  if (!result.ok) {
    console.info('[SESSION_GUARD] blocked player session check', {
      reason: result.reason,
      uid: currentUser?.uid || null,
      localSessionId: localSessionId || null,
      activeSessionId: result.activeSessionId || null,
      source: result.source || null,
    });

    if (
      result.reason === 'not_player_app_session' ||
      result.reason === 'missing_local_session_id' ||
      result.reason === 'missing_auth_user'
    ) {
      throw new Error('Player session required.');
    }

    if (result.reason === 'session_replaced') {
      console.info('[SESSION_GUARD] old device kicked because session mismatch', {
        uid: currentUser?.uid || null,
        localSessionId,
        activeSessionId: result.activeSessionId || null,
      });
    }

    await forcePlayerSessionLogout({
      markSessionInactive:
        result.reason === 'session_replaced' || result.reason === 'session_inactive',
    });
    throw new Error(PLAYER_REPLACED_LOGIN_MESSAGE);
  }

  console.info('[SESSION_GUARD] allowed player session check', {
    uid: currentUser?.uid || null,
    sessionId: localSessionId,
    source: result.source || 'sql',
  });
}

export async function getPlayerApiHeaders(contentType = true) {
  const localSessionId = getLocalPlayerSessionId();
  const sqlPlayerMode = isSqlPlayerAppSessionMode();
  const cached =
    localSessionId && !forcedPlayerLogout
      ? readPlayerSessionVerifyCache(localSessionId)
      : null;
  if (!cached?.ok) {
    if (sqlPlayerMode) {
      const result = await verifyActivePlayerSession();
      if (
        !result.ok &&
        (result.reason === 'session_replaced' || result.reason === 'session_inactive')
      ) {
        await forcePlayerSessionLogout({
          markSessionInactive: true,
        });
        throw new Error(PLAYER_REPLACED_LOGIN_MESSAGE);
      }
    } else {
      await assertActivePlayerSession();
    }
  }
  const headers = await buildPlayerSessionRequestHeaders(contentType);
  const hasBearer = Boolean(headers.Authorization);
  const hasAppSession = Boolean(headers['X-App-Session-Id']);
  const hasPlayerSession = Boolean(headers['X-Player-Session-Id']);
  if (!hasBearer && !hasAppSession) {
    throw new Error('Not authenticated.');
  }
  if (!hasBearer && hasAppSession && !hasPlayerSession) {
    throw new Error('Not authenticated.');
  }
  console.info('[PLAYER_API_HEADERS]', {
    mode: resolvePlayerApiHeaderMode(headers),
    hasAppSession,
    hasPlayerSession,
    hasFirebaseUser: Boolean(auth.currentUser),
    app_session_id: headers['X-App-Session-Id'] || null,
    player_session_id: headers['X-Player-Session-Id'] || null,
    canonical_session_id: headers['X-Player-Session-Id'] || null,
  });
  return headers;
}

async function startPlayerSessionViaApi(
  user: User,
  deviceId: string,
  activeSessionDevice: ReturnType<typeof getPlayerSessionDevice>
) {
  try {
    const token = await user.getIdToken();
    const response = await fetch('/api/auth/player-session/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        deviceId,
        userAgent: activeSessionDevice.userAgent,
        platform: activeSessionDevice.platform,
      }),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      ok?: boolean;
      sessionId?: string;
      sqlOk?: boolean;
    };
    if (!payload.ok || !payload.sessionId) {
      return null;
    }
    console.info('[PLAYER_LOGIN_SESSION] sql session start ok', {
      uid: user.uid,
      sessionId: payload.sessionId,
      sqlOk: payload.sqlOk === true,
    });
    return { sessionId: String(payload.sessionId), deviceId };
  } catch (error) {
    console.info('[PLAYER_LOGIN_SESSION] sql session start failed, using firestore fallback', {
      uid: user.uid,
      error,
    });
    return null;
  }
}

async function startPlayerSessionViaFirestore(user: User, deviceId: string) {
  const sessionId = makeId();
  const activeSessionDevice = getPlayerSessionDevice(deviceId);
  const userRef = doc(db, 'users', user.uid);
  const sessionRef = doc(db, 'playerSessions', sessionId);
  let previousSessionId = '';

  console.info('[PLAYER_LOGIN_SESSION] generated sessionId', {
    uid: user.uid,
    sessionId,
    deviceId,
  });

  await runTransaction(db, async (transaction) => {
    const userSnap = await transaction.get(userRef);
    previousSessionId = String(userSnap.data()?.activeSessionId || '').trim();

    console.info('[PLAYER_LOGIN_SESSION] previous activeSessionId', {
      uid: user.uid,
      previousSessionId: previousSessionId || null,
    });

    transaction.set(sessionRef, {
      playerUid: user.uid,
      deviceId,
      startedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
      active: true,
    });
    transaction.update(userRef, {
      activeSessionId: sessionId,
      activeDeviceId: deviceId,
      activeSessionDevice,
      activeSessionStartedAt: serverTimestamp(),
      activeSessionLastSeenAt: serverTimestamp(),
      activeSessionUpdatedAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
  });

  if (previousSessionId && previousSessionId !== sessionId) {
    const previousSessionRef = doc(db, 'playerSessions', previousSessionId);
    try {
      const previousSessionSnap = await getDoc(previousSessionRef);
      if (previousSessionSnap.exists()) {
        await updateDoc(previousSessionRef, {
          active: false,
          endedAt: serverTimestamp(),
          endedReason: 'replaced_by_new_login',
        });
        console.info('[PLAYER_LOGIN_SESSION] previous player session marked inactive', {
          uid: user.uid,
          previousSessionId,
          activeSessionId: sessionId,
        });
      } else {
        console.info('[PLAYER_LOGIN_SESSION] previous player session cleanup skipped', {
          uid: user.uid,
          previousSessionId,
          activeSessionId: sessionId,
          reason: 'previous_session_doc_missing',
        });
      }
    } catch (error) {
      console.warn('[PLAYER_LOGIN_SESSION] previous player session cleanup failed', {
        uid: user.uid,
        previousSessionId,
        activeSessionId: sessionId,
        error,
      });
    }
  }

  return { sessionId, deviceId };
}

export async function startPlayerSession(user: User) {
  forcedPlayerLogout = false;
  const deviceId = getOrCreatePlayerDeviceId();
  const activeSessionDevice = getPlayerSessionDevice(deviceId);

  const sqlStarted = await startPlayerSessionViaApi(user, deviceId, activeSessionDevice);
  const result = sqlStarted || (await startPlayerSessionViaFirestore(user, deviceId));

  storeLocalPlayerSessionId(result.sessionId);

  console.info('[PLAYER_LOGIN_SESSION] newly saved activeSessionId', {
    uid: user.uid,
    activeSessionId: result.sessionId,
    source: sqlStarted ? 'sql' : 'firestore_fallback',
    reason: 'new_login_force_replaced_previous_session',
  });

  return result;
}

async function touchPlayerSessionViaApi(sessionId: string) {
  try {
    const response = await fetch('/api/auth/player-session/touch', {
      method: 'POST',
      headers: await buildPlayerSessionRequestHeaders(true),
      body: JSON.stringify({
        sessionId,
        deviceId: getOrCreatePlayerDeviceId(),
      }),
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}

async function touchPlayerSessionViaFirestore(user: User, sessionId: string) {
  await Promise.all([
    updateDoc(doc(db, 'users', user.uid), {
      activeSessionLastSeenAt: serverTimestamp(),
      activeSessionUpdatedAt: serverTimestamp(),
    }),
    setDoc(
      doc(db, 'playerSessions', sessionId),
      {
        playerUid: user.uid,
        deviceId: getOrCreatePlayerDeviceId(),
        lastSeenAt: serverTimestamp(),
        active: true,
      },
      { merge: true }
    ),
  ]);
}

export async function touchPlayerSession(user?: User | null) {
  const sessionId = getLocalPlayerSessionId();
  if (!sessionId) {
    return;
  }

  const resolvedUser = user === undefined ? auth.currentUser : user;
  const sqlOk = await touchPlayerSessionViaApi(sessionId);
  if (!sqlOk && resolvedUser && !isSqlPlayerAppSessionMode()) {
    await touchPlayerSessionViaFirestore(resolvedUser, sessionId);
  }
}

async function endLocalPlayerSessionViaApi(sessionId: string, reason: string) {
  try {
    const response = await fetch('/api/auth/player-session/end', {
      method: 'POST',
      headers: await buildPlayerSessionRequestHeaders(true),
      body: JSON.stringify({
        sessionId,
        reason,
      }),
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}

async function endLocalPlayerSessionViaFirestore(sessionId: string, reason: string) {
  await setDoc(
    doc(db, 'playerSessions', sessionId),
    {
      active: false,
      endedAt: serverTimestamp(),
      endedReason: reason,
    },
    { merge: true }
  );
}

export async function endLocalPlayerSession(reason = 'logout') {
  const sessionId = getLocalPlayerSessionId();
  if (!sessionId) {
    return;
  }

  const currentUser = auth.currentUser;
  try {
    const sqlOk = await endLocalPlayerSessionViaApi(sessionId, reason);
    if (!sqlOk && currentUser && !isSqlPlayerAppSessionMode()) {
      await endLocalPlayerSessionViaFirestore(sessionId, reason);
    }
  } catch {
    // Best effort; realtime activeSessionId still protects the account.
  }
}

export function listenForPlayerSessionReplacement(
  user: User,
  onMismatch?: () => void
) {
  if (
    getLocalAppSessionId() ||
    isSqlPlayerAppSessionMode() ||
    isSqlPlayerLoginEnabled() ||
    isClientSqlReadMode()
  ) {
    logClientFirestoreSkipped('player_session_replacement_listener', { uid: user.uid });
    return () => {};
  }

  const localSessionId = getLocalPlayerSessionId();
  if (!localSessionId) {
    return () => {};
  }

  return onSnapshot(doc(db, 'users', user.uid), async (snapshot) => {
    const activeSessionId = String(snapshot.data()?.activeSessionId || '').trim();
    if (!activeSessionId || activeSessionId === localSessionId) {
      return;
    }

    console.info('[SESSION_GUARD] old device kicked because session mismatch', {
      uid: user.uid,
      localSessionId,
      activeSessionId,
    });
    onMismatch?.();
  });
}
