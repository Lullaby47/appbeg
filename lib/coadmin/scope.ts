import { doc, getDoc } from 'firebase/firestore';

import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { auth, db } from '@/lib/firebase/client';

export type CoadminScopedRecord = {
  uid?: string | null;
  role?: string | null;
  createdBy?: string | null;
  coadminUid?: string | null;
};

function normalizeUid(value: unknown) {
  const uid = String(value || '').trim();
  return uid || null;
}

export function resolveCoadminUid(record: CoadminScopedRecord) {
  if (record.role === 'coadmin') {
    return normalizeUid(record.uid);
  }

  return normalizeUid(record.coadminUid) || normalizeUid(record.createdBy);
}

export function belongsToCoadmin(
  item: Pick<CoadminScopedRecord, 'createdBy' | 'coadminUid'>,
  coadminUid: string
) {
  return item.coadminUid === coadminUid || item.createdBy === coadminUid;
}

export async function getCoadminActorUid() {
  const cached = getCachedSessionUser();
  if (cached?.uid) {
    return cached.uid;
  }

  const sessionUser = await getSessionUserOnce();
  if (sessionUser?.uid) {
    return sessionUser.uid;
  }

  const firebaseUid = auth.currentUser?.uid;
  if (firebaseUid) {
    return firebaseUid;
  }

  throw new Error('Not authenticated.');
}

function resolveCoadminUidFromSessionUser(sessionUser: {
  uid: string;
  role: string;
  coadminUid?: string | null;
}) {
  const role = String(sessionUser.role || '').toLowerCase();
  if (role === 'coadmin') {
    return normalizeUid(sessionUser.uid);
  }

  return normalizeUid(sessionUser.coadminUid);
}

export async function getCurrentUserCoadminUid() {
  const cached = getCachedSessionUser();
  const sessionUser = cached?.uid ? cached : await getSessionUserOnce();

  if (sessionUser?.uid) {
    const coadminUid = resolveCoadminUidFromSessionUser(sessionUser);
    if (coadminUid) {
      return coadminUid;
    }
    throw new Error('No coadmin assigned to this user.');
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('get_current_user_coadmin_uid_firestore_fallback', {
      uid: currentUser.uid,
    });
    throw new Error('No coadmin assigned to this user.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));
  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const coadminUid = resolveCoadminUid({
    uid: currentUser.uid,
    ...(userSnap.data() as CoadminScopedRecord),
  });

  if (!coadminUid) {
    throw new Error('No coadmin assigned to this user.');
  }

  return coadminUid;
}
