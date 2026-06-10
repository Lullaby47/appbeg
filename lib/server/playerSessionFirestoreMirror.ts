import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';

import { adminDb } from '@/lib/firebase/admin';
import { isPlayerSessionSqlReadEnabled } from '@/lib/server/authSqlRead';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export async function mirrorPlayerSessionStartToFirestore(input: {
  playerUid: string;
  sessionId: string;
  deviceId: string;
  userAgent?: string | null;
  platform?: string | null;
  previousSessionIds: string[];
}) {
  if (isPlayerSessionSqlReadEnabled()) {
    return false;
  }

  const playerUid = cleanText(input.playerUid);
  const sessionId = cleanText(input.sessionId);
  const deviceId = cleanText(input.deviceId);
  if (!playerUid || !sessionId || !deviceId) {
    return false;
  }

  const activeSessionDevice = {
    deviceId,
    ...(input.userAgent ? { userAgent: cleanText(input.userAgent) } : {}),
    ...(input.platform ? { platform: cleanText(input.platform) } : {}),
  };

  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route: '/api/auth/player-session/start',
    operation: 'batch',
    collection: 'users,playerSessions',
    document_id: sessionId,
    details: { playerUid, previousSessionCount: input.previousSessionIds.length },
  });
  const batch = adminDb.batch();
  const userRef = adminDb.collection('users').doc(playerUid);
  const sessionRef = adminDb.collection('playerSessions').doc(sessionId);

  batch.set(sessionRef, {
    playerUid,
    deviceId,
    startedAt: FieldValue.serverTimestamp(),
    lastSeenAt: FieldValue.serverTimestamp(),
    active: true,
  });

  batch.set(
    userRef,
    {
      activeSessionId: sessionId,
      activeDeviceId: deviceId,
      activeSessionDevice,
      activeSessionStartedAt: FieldValue.serverTimestamp(),
      activeSessionLastSeenAt: FieldValue.serverTimestamp(),
      activeSessionUpdatedAt: FieldValue.serverTimestamp(),
      lastLoginAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  for (const previousSessionId of input.previousSessionIds) {
    const cleanPreviousId = cleanText(previousSessionId);
    if (!cleanPreviousId || cleanPreviousId === sessionId) {
      continue;
    }
    batch.set(
      adminDb.collection('playerSessions').doc(cleanPreviousId),
      {
        active: false,
        endedAt: FieldValue.serverTimestamp(),
        endedReason: 'replaced_by_new_login',
      },
      { merge: true }
    );
  }

  await batch.commit();
  return true;
}

export async function mirrorPlayerSessionTouchToFirestore(input: {
  playerUid: string;
  sessionId: string;
  deviceId?: string | null;
}) {
  if (isPlayerSessionSqlReadEnabled()) {
    return false;
  }

  const playerUid = cleanText(input.playerUid);
  const sessionId = cleanText(input.sessionId);
  if (!playerUid || !sessionId) {
    return false;
  }

  const deviceId = cleanText(input.deviceId);
  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route: '/api/auth/player-session/touch',
    operation: 'batch',
    collection: 'users,playerSessions',
    document_id: sessionId,
    details: { playerUid },
  });
  const batch = adminDb.batch();
  batch.set(
    adminDb.collection('playerSessions').doc(sessionId),
    {
      playerUid,
      ...(deviceId ? { deviceId } : {}),
      lastSeenAt: FieldValue.serverTimestamp(),
      active: true,
    },
    { merge: true }
  );
  batch.set(
    adminDb.collection('users').doc(playerUid),
    {
      activeSessionLastSeenAt: FieldValue.serverTimestamp(),
      activeSessionUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await batch.commit();
  return true;
}

export async function mirrorPlayerSessionEndToFirestore(input: {
  playerUid: string;
  sessionId: string;
  reason: string;
}) {
  if (isPlayerSessionSqlReadEnabled()) {
    return false;
  }

  const playerUid = cleanText(input.playerUid);
  const sessionId = cleanText(input.sessionId);
  if (!playerUid || !sessionId) {
    return false;
  }

  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route: '/api/auth/player-session/end',
    operation: 'write',
    collection: 'playerSessions',
    document_id: sessionId,
    details: { playerUid, reason: cleanText(input.reason) || 'logout' },
  });
  await adminDb.collection('playerSessions').doc(sessionId).set(
    {
      active: false,
      endedAt: FieldValue.serverTimestamp(),
      endedReason: cleanText(input.reason) || 'logout',
    },
    { merge: true }
  );
  return true;
}
