import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { getCurrentUserCoadminUid } from '@/lib/coadmin/scope';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
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

  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('coadmin_maintenance_break_listener', { coadminUid: cleanCoadminUid });
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

export async function getCoadminMaintenanceBreakClient(
  coadminUid: string
): Promise<MaintenanceBreak> {
  const cleanCoadminUid = String(coadminUid || '').trim();
  if (!cleanCoadminUid) {
    return normalizeMaintenanceBreak(null);
  }

  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('coadmin_maintenance_break_get', { coadminUid: cleanCoadminUid });
    return normalizeMaintenanceBreak(null);
  }

  const snapshot = await getDoc(doc(db, 'coadminMaintenance', cleanCoadminUid));
  return normalizeMaintenanceBreak(snapshot.data()?.maintenanceBreak);
}

export async function setCoadminMaintenanceBreak(enabled: boolean) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const coadminUid = await getCurrentUserCoadminUid();

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
    doc(db, 'coadminMaintenance', coadminUid),
    {
      coadminUid,
      maintenanceBreak,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.uid,
    },
    { merge: true }
  );
}
