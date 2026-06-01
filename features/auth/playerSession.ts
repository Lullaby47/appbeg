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

import { auth, db } from '@/lib/firebase/client';

export const PLAYER_DEVICE_ID_KEY = 'appbeg:playerDeviceId';
export const PLAYER_SESSION_ID_KEY = 'appbeg:playerSessionId';
export const PLAYER_REPLACED_LOGIN_MESSAGE =
  'You were logged out because this account logged in on another device.';
export const PLAYER_SESSION_REPLACED_LOGIN_PATH = '/login?reason=session_replaced';

let forcedPlayerLogout = false;

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

export function isPlayerForcedLogout() {
  return forcedPlayerLogout;
}

export function clearPlayerBrowserState() {
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

export async function forcePlayerSessionLogout(options?: {
  redirect?: (url: string) => void;
  markSessionInactive?: boolean;
}) {
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

export async function assertActivePlayerSession() {
  const currentUser = auth.currentUser;
  const localSessionId = getLocalPlayerSessionId();
  if (!currentUser || !localSessionId || forcedPlayerLogout) {
    console.info('[SESSION_GUARD] blocked player session check', {
      reason: !currentUser
        ? 'missing_auth_user'
        : !localSessionId
          ? 'missing_local_session_id'
          : 'forced_logout_already_set',
      uid: currentUser?.uid || null,
      localSessionId: localSessionId || null,
    });
    await forcePlayerSessionLogout({ markSessionInactive: false });
    throw new Error(PLAYER_REPLACED_LOGIN_MESSAGE);
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
  const activeSessionId = String(userSnap.data()?.activeSessionId || '').trim();
  if (!activeSessionId || activeSessionId !== localSessionId) {
    console.info('[SESSION_GUARD] old device kicked because session mismatch', {
      uid: currentUser.uid,
      localSessionId,
      activeSessionId: activeSessionId || null,
    });
    await forcePlayerSessionLogout();
    throw new Error(PLAYER_REPLACED_LOGIN_MESSAGE);
  }

  console.info('[SESSION_GUARD] allowed player session check', {
    uid: currentUser.uid,
    sessionId: localSessionId,
  });
}

export async function getPlayerApiHeaders(contentType = true) {
  await assertActivePlayerSession();
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const token = await currentUser.getIdToken();
  const sessionId = getLocalPlayerSessionId();
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`,
    'X-Player-Session-Id': sessionId,
  };
}

export async function startPlayerSession(user: User) {
  forcedPlayerLogout = false;
  const sessionId = makeId();
  const deviceId = getOrCreatePlayerDeviceId();
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

  window.localStorage.setItem(PLAYER_SESSION_ID_KEY, sessionId);

  console.info('[PLAYER_LOGIN_SESSION] newly saved activeSessionId', {
    uid: user.uid,
    previousSessionId: previousSessionId || null,
    activeSessionId: sessionId,
    reason: 'new_login_force_replaced_previous_session',
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

export async function touchPlayerSession(user: User) {
  const sessionId = getLocalPlayerSessionId();
  if (!sessionId) {
    return;
  }

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

export async function endLocalPlayerSession(reason = 'logout') {
  const currentUser = auth.currentUser;
  const sessionId = getLocalPlayerSessionId();
  if (!currentUser || !sessionId) {
    return;
  }

  try {
    await setDoc(
      doc(db, 'playerSessions', sessionId),
      {
        active: false,
        endedAt: serverTimestamp(),
        endedReason: reason,
      },
      { merge: true }
    );
  } catch {
    // Best effort; realtime activeSessionId still protects the account.
  }
}

export function listenForPlayerSessionReplacement(
  user: User,
  onMismatch?: () => void
) {
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
