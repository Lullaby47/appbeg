import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';

import { auth, getClientDb } from '@/lib/firebase/client';
import { logClientFirestoreSkipped, isClientSqlReadMode } from '@/lib/client/sqlReadMode';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

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

const AUTO_STATE_SQL_POLL_MS = 5_000;

async function fetchCarerAutomationAutoStateSql(
  carerUid: string
): Promise<CarerAutomationAutoStateDoc | null> {
  const response = await fetch('/api/carer/automation-auto-state', {
    method: 'GET',
    headers: await getFirebaseApiHeaders(),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error('Failed to load automation auto state.');
  }
  const payload = (await response.json().catch(() => ({}))) as {
    state?: CarerAutomationAutoStateDoc | null;
  };
  return payload.state ?? null;
}

export function subscribeCarerAutomationAutoState(
  carerUid: string,
  onData: (data: CarerAutomationAutoStateDoc | null) => void,
  onError: (error: Error) => void
) {
  if (isClientSqlReadMode()) {
    logClientFirestoreSkipped('automation_auto_state', { carerUid });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) {
        return;
      }
      try {
        const state = await fetchCarerAutomationAutoStateSql(carerUid);
        if (!cancelled) {
          onData(state);
        }
      } catch (error) {
        if (!cancelled) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void tick();
          }, AUTO_STATE_SQL_POLL_MS);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

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
