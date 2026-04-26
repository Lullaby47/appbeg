import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { belongsToCoadmin, resolveCoadminUid, type CoadminScopedRecord } from '@/lib/coadmin/scope';

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
  const sessionsQuery = query(
    collection(db, 'shiftSessions'),
    where('coadminUid', '==', coadminUid)
  );
  return onSnapshot(
    sessionsQuery,
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

  const currentSnap = await getDoc(doc(db, 'users', currentUser.uid));
  if (!currentSnap.exists()) {
    throw new Error('Current user profile not found.');
  }
  const currentData = currentSnap.data() as CoadminScopedRecord;
  if (String(currentData.role || '').toLowerCase() !== 'coadmin') {
    throw new Error('Only coadmin can cut rewards.');
  }
  const currentCoadminUid = resolveCoadminUid({
    uid: currentUser.uid,
    ...currentData,
  });
  if (!currentCoadminUid) {
    throw new Error('No coadmin scope found.');
  }

  const targetRef = doc(db, 'users', values.workerUid);
  let updatedCashBox = 0;
  await runTransaction(db, async (transaction) => {
    const targetSnap = await transaction.get(targetRef);
    if (!targetSnap.exists()) {
      throw new Error('Worker account not found.');
    }
    const targetData = targetSnap.data() as CoadminScopedRecord & {
      cashBoxNpr?: number;
      username?: string;
      role?: string;
    };
    if (!belongsToCoadmin(targetData, currentCoadminUid)) {
      throw new Error('Worker is outside your coadmin scope.');
    }
    const role = String(targetData.role || '').toLowerCase();
    if (role !== values.workerRole) {
      throw new Error('Worker role mismatch.');
    }
    const oldCash = Math.max(0, Number(targetData.cashBoxNpr || 0));
    const cutAmount = Math.max(0, Math.round(Number(values.amountNpr || 0)));
    if (cutAmount <= 0) {
      throw new Error('Cut amount must be greater than 0.');
    }
    updatedCashBox = Math.max(0, oldCash - cutAmount);
    transaction.update(targetRef, {
      cashBoxNpr: updatedCashBox,
      lastRewardCutAt: serverTimestamp(),
    });
  });

  await addDoc(collection(db, 'rewardCuts'), {
    coadminUid: currentCoadminUid,
    workerUid: values.workerUid,
    workerRole: values.workerRole,
    workerUsername: values.workerUsername || 'Worker',
    amountNpr: Math.max(0, Math.round(Number(values.amountNpr || 0))),
    reason: values.reason.trim() || 'Manual adjustment',
    createdAt: serverTimestamp(),
    createdByUid: currentUser.uid,
  });

  return { updatedCashBox };
}
