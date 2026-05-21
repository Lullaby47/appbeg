'use client';

import { User, signOut } from 'firebase/auth';
import {
  doc,
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

function makeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

export async function getPlayerApiHeaders(contentType = true) {
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
  const sessionId = makeId();
  const deviceId = getOrCreatePlayerDeviceId();
  const userRef = doc(db, 'users', user.uid);
  const sessionRef = doc(db, 'playerSessions', sessionId);

  await runTransaction(db, async (transaction) => {
    const userSnap = await transaction.get(userRef);
    const previousSessionId = String(userSnap.data()?.activeSessionId || '').trim();
    if (previousSessionId && previousSessionId !== sessionId) {
      transaction.set(
        doc(db, 'playerSessions', previousSessionId),
        {
          active: false,
          endedAt: serverTimestamp(),
          endedReason: 'replaced_by_new_login',
        },
        { merge: true }
      );
    }

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
      activeSessionStartedAt: serverTimestamp(),
      activeSessionLastSeenAt: serverTimestamp(),
    });
  });

  window.localStorage.setItem(PLAYER_SESSION_ID_KEY, sessionId);
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

export function clearPlayerBrowserState() {
  if (typeof window === 'undefined') {
    return;
  }
  const deviceId = window.localStorage.getItem(PLAYER_DEVICE_ID_KEY);
  window.localStorage.clear();
  window.sessionStorage.clear();
  if (deviceId) {
    window.localStorage.setItem(PLAYER_DEVICE_ID_KEY, deviceId);
  }
}

export function listenForPlayerSessionReplacement(user: User) {
  const localSessionId = getLocalPlayerSessionId();
  if (!localSessionId) {
    return () => {};
  }

  return onSnapshot(doc(db, 'users', user.uid), async (snapshot) => {
    const activeSessionId = String(snapshot.data()?.activeSessionId || '').trim();
    if (!activeSessionId || activeSessionId === localSessionId) {
      return;
    }

    await endLocalPlayerSession('replaced_by_new_login');
    clearPlayerBrowserState();
    await signOut(auth);
    window.location.replace('/login?message=another-device');
  });
}
