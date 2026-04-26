import { doc, getDoc } from 'firebase/firestore';

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

export async function getCurrentUserCoadminUid() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
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
