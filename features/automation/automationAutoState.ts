import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';

import { auth, getClientDb } from '@/lib/firebase/client';

export const AUTOMATION_AUTO_STATE_COLLECTION = 'automation_auto_state';

export type CarerAutomationAutoStateDoc = {
  enabled?: boolean;
  startedAt?: unknown;
  startedBy?: string;
  stoppedAt?: unknown;
  updatedAt?: unknown;
  tickLeaseHolderId?: string;
  tickLeaseExpiresAt?: unknown;
};

export function subscribeCarerAutomationAutoState(
  carerUid: string,
  onData: (data: CarerAutomationAutoStateDoc | null) => void,
  onError: (error: Error) => void
) {
  const db = getClientDb('automationAutoState');
  const ref = doc(db, AUTOMATION_AUTO_STATE_COLLECTION, carerUid);
  return onSnapshot(
    ref,
    (snap) => {
      onData(snap.exists() ? (snap.data() as CarerAutomationAutoStateDoc) : null);
    },
    (error) => {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  );
}

export async function setCarerAutomationAutoEnabled(input: {
  carerUid: string;
  coadminUid: string;
  enabled: boolean;
}) {
  const user = auth.currentUser;
  if (!user || user.uid !== input.carerUid) {
    throw new Error('Not signed in as this carer.');
  }
  const coadmin = String(input.coadminUid || '').trim();
  if (!coadmin) {
    throw new Error('Coadmin scope is required.');
  }

  const db = getClientDb('setCarerAutomationAutoEnabled');
  const ref = doc(db, AUTOMATION_AUTO_STATE_COLLECTION, input.carerUid);

  console.info('[AUTO_UI] writing automation enabled state', {
    carerUid: input.carerUid,
    coadminUid: coadmin,
    enabled: input.enabled,
  });
  await setDoc(
    ref,
    {
      enabled: input.enabled,
      updatedAt: serverTimestamp(),
      ...(input.enabled
        ? {
            startedAt: serverTimestamp(),
            startedBy: input.carerUid,
            stoppedAt: null,
          }
        : {
            stoppedAt: serverTimestamp(),
          }),
    },
    { merge: true }
  );
  console.info('[AUTO_UI] backend state written', {
    carerUid: input.carerUid,
    coadminUid: coadmin,
    enabled: input.enabled,
    autoTickRequestFiredByUi: false,
    reason: 'persistent automation is polled by the local automation agent',
  });
}
