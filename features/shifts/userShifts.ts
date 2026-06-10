import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { clientOnSnapshot } from '@/lib/client/clientFirestoreQuery';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export type ShiftRole = 'staff' | 'carer';

export type ShiftSession = {
  id: string;
  coadminUid: string;
  userUid: string;
  userRole: ShiftRole;
  userUsername: string;
  loginAt?: Timestamp | null;
  logoutAt?: Timestamp | null;
  lastSeenAt?: Timestamp | null;
  isActive: boolean;
};

export async function startShiftSession(values: {
  coadminUid: string;
  userUid: string;
  userRole: ShiftRole;
  userUsername: string;
}) {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== values.userUid) {
    throw new Error('Not authenticated.');
  }

  const activeQuery = query(
    collection(db, 'shiftSessions'),
    where('userUid', '==', values.userUid),
    where('isActive', '==', true)
  );
  const activeSnap = await getDocs(activeQuery);
  await Promise.all(
    activeSnap.docs.map((docSnap) =>
      updateDoc(docSnap.ref, {
        isActive: false,
        logoutAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      })
    )
  );

  const created = await addDoc(collection(db, 'shiftSessions'), {
    coadminUid: values.coadminUid,
    userUid: values.userUid,
    userRole: values.userRole,
    userUsername: values.userUsername || 'User',
    loginAt: serverTimestamp(),
    logoutAt: null,
    lastSeenAt: serverTimestamp(),
    isActive: true,
  });

  return created.id;
}

export async function heartbeatShiftSession(sessionId: string) {
  if (!sessionId) {
    return;
  }
  await updateDoc(doc(db, 'shiftSessions', sessionId), {
    lastSeenAt: serverTimestamp(),
    isActive: true,
  });
}

export async function endShiftSession(sessionId: string) {
  if (!sessionId) {
    return;
  }
  await updateDoc(doc(db, 'shiftSessions', sessionId), {
    isActive: false,
    logoutAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  });
}

export function listenShiftSessionsByCoadmin(
  coadminUid: string,
  onChange: (items: ShiftSession[]) => void,
  onError?: (error: Error) => void
) {
  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('shift_sessions_listener', { coadminUid });
    onChange([]);
    return () => {};
  }

  const sessionsQuery = query(
    collection(db, 'shiftSessions'),
    where('coadminUid', '==', coadminUid)
  );
  return clientOnSnapshot(
    sessionsQuery,
    {
      file: 'features/shifts/userShifts.ts',
      hook: 'listenShiftSessionsByCoadmin',
      collection: 'shiftSessions',
      where: { coadminUid },
    },
    (snapshot) => {
      const items = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<ShiftSession, 'id'>),
      }));
      onChange(items);
    },
    (error) => onError?.(error as Error)
  );
}

export function calculateWorkedHoursLast24h(
  sessions: ShiftSession[],
  nowMs: number = Date.now()
) {
  const windowStart = nowMs - 24 * 60 * 60 * 1000;
  let totalMs = 0;
  for (const session of sessions) {
    const login = session.loginAt?.toMillis?.() || 0;
    if (!login) {
      continue;
    }
    const logout = session.logoutAt?.toMillis?.() || nowMs;
    const start = Math.max(login, windowStart);
    const end = Math.min(logout, nowMs);
    if (end > start) {
      totalMs += end - start;
    }
  }
  return totalMs / (1000 * 60 * 60);
}

export async function cutWorkerReward(values: {
  workerUid: string;
  workerRole: ShiftRole;
  workerUsername: string;
  amountNpr: number;
  reason: string;
}) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const response = await fetch('/api/coadmin/workers/cut-reward', {
    method: 'POST',
    headers: await getFirebaseApiHeaders(),
    body: JSON.stringify(values),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    updatedCashBox?: number;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to cut reward.');
  }
  return { updatedCashBox: Number(payload.updatedCashBox || 0) };
}
