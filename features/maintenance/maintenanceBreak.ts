import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import {
  DEFAULT_MAINTENANCE_MESSAGE,
  DEFAULT_MAINTENANCE_TITLE,
  normalizeMaintenanceBreak,
  type MaintenanceBreak,
} from '@/lib/maintenance/config';

export function listenCoadminMaintenanceBreak(
  coadminUid: string,
  onChange: (maintenanceBreak: MaintenanceBreak) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const cleanCoadminUid = String(coadminUid || '').trim();
  if (!cleanCoadminUid) {
    onChange(normalizeMaintenanceBreak(null));
    return () => {};
  }

  return onSnapshot(
    doc(db, 'coadminMaintenance', cleanCoadminUid),
    (snapshot) => {
      onChange(normalizeMaintenanceBreak(snapshot.data()?.maintenanceBreak));
    },
    (error) => {
      onChange(normalizeMaintenanceBreak(null));
      onError?.(error as Error);
    }
  );
}

export async function setCoadminMaintenanceBreak(enabled: boolean) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const maintenanceBreak = enabled
    ? {
        enabled: true,
        title: DEFAULT_MAINTENANCE_TITLE,
        message: DEFAULT_MAINTENANCE_MESSAGE,
        startedAt: serverTimestamp(),
        startedBy: currentUser.uid,
        endedAt: null,
      }
    : {
        enabled: false,
        title: DEFAULT_MAINTENANCE_TITLE,
        message: DEFAULT_MAINTENANCE_MESSAGE,
        endedAt: serverTimestamp(),
      };

  await setDoc(
    doc(db, 'coadminMaintenance', currentUser.uid),
    {
      coadminUid: currentUser.uid,
      maintenanceBreak,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.uid,
    },
    { merge: true }
  );
}
