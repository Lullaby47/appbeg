import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { auth, getClientDb } from '@/lib/firebase/client';
import { logCarerPageRequestAudit } from '@/lib/client/carerPageRequestAudit';
import { logClientFirestoreSkipped, isClientSqlReadMode } from '@/lib/client/sqlReadMode';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';

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

function logCarerStopAutomationAudit(input: {
  action: 'start_automation' | 'stop_automation';
  file: string;
  function: string;
  carerUidFromProfile: string | null;
  uidFromSessionMe: string | null;
  firebaseCurrentUserUid: string | null;
  appSessionIdPrefix: string | null;
  role: string | null;
  sqlMode: boolean;
  authSource: string;
  willCallApi: boolean;
  reason: string;
}) {
  console.info('[CARER_STOP_AUTOMATION_AUDIT]', input);
}

function logCarerAutomationStateRequest(input: {
  route: string;
  method: string;
  enabled: boolean;
  carerUid: string | null;
  role: string | null;
  hasAppSessionId: boolean;
  authHeaderMode: string;
  status: number;
  responseBody: unknown;
  reason: string;
}) {
  console.info('[CARER_AUTOMATION_STATE_REQUEST]', input);
}

async function resolveSessionCarerUid() {
  const cached = getCachedSessionUser();
  if (cached?.uid) {
    return cached;
  }
  return getSessionUserOnce().catch(() => null);
}

async function fetchCarerAutomationAutoStateSql(
  carerUid: string
): Promise<CarerAutomationAutoStateDoc | null> {
  const response = await fetch('/api/carer/automation-auto-state', {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    state?: CarerAutomationAutoStateDoc | null;
    error?: string;
  };
  logCarerPageRequestAudit({
    route: '/api/carer/automation-auto-state',
    method: 'GET',
    status: response.status,
    carerUid,
    role: 'carer',
    authPath: 'app_session_sql',
    reason: response.ok
      ? 'automation_auto_state_ok'
      : String(payload.error || `http_${response.status}`),
  });
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load automation auto state.');
  }
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
  const coadmin = String(input.coadminUid || '').trim();
  if (!coadmin) {
    throw new Error('Coadmin scope is required.');
  }

  const carerUidFromProfile = String(input.carerUid || '').trim();
  const sqlMode = isClientSqlReadMode();
  const firebaseCurrentUserUid = auth.currentUser?.uid ?? null;
  const sessionUser = sqlMode ? await resolveSessionCarerUid() : getCachedSessionUser();
  const uidFromSessionMe = sessionUser?.uid ?? null;
  const role = sessionUser?.role ? String(sessionUser.role) : null;
  const appSessionIdPrefix = getLocalAppSessionId()?.slice(0, 8) ?? null;
  const auditAction = input.enabled ? 'start_automation' : 'stop_automation';

  if (sqlMode) {
    const uidMismatch =
      Boolean(uidFromSessionMe) &&
      Boolean(carerUidFromProfile) &&
      uidFromSessionMe !== carerUidFromProfile;

    logCarerStopAutomationAudit({
      action: auditAction,
      file: 'features/automation/automationAutoState.ts',
      function: 'setCarerAutomationAutoEnabled',
      carerUidFromProfile: carerUidFromProfile || null,
      uidFromSessionMe,
      firebaseCurrentUserUid,
      appSessionIdPrefix,
      role,
      sqlMode: true,
      authSource: 'app_session_sql',
      willCallApi: !uidMismatch,
      reason: uidMismatch ? 'session_uid_mismatch' : 'sql_app_session',
    });

    if (uidMismatch) {
      throw new Error('Session changed. Please refresh.');
    }

    const response = await fetch('/api/carer/automation-auto-state', {
      method: 'POST',
      headers: await getSqlApiReadHeaders(true),
      body: JSON.stringify({ enabled: input.enabled }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      enabled?: boolean;
      ok?: boolean;
    };

    logCarerAutomationStateRequest({
      route: '/api/carer/automation-auto-state',
      method: 'POST',
      enabled: input.enabled,
      carerUid: carerUidFromProfile || uidFromSessionMe,
      role: role || 'carer',
      hasAppSessionId: Boolean(getLocalAppSessionId()),
      authHeaderMode: 'app_session_sql',
      status: response.status,
      responseBody: payload,
      reason: response.ok
        ? 'ok'
        : String(payload.error || `http_${response.status}`),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Session changed. Please refresh.');
      }
      throw new Error(payload.error || 'Failed to save automation auto state.');
    }

    console.info('[CARER_AUTOMATION_STATE_SQL_WRITE]', {
      carerUid: carerUidFromProfile || uidFromSessionMe,
      enabled: input.enabled,
      source: 'sql',
      firestoreAttempted: false,
    });
    console.info('[AUTO_UI] backend state written', {
      carerUid: carerUidFromProfile || uidFromSessionMe,
      coadminUid: coadmin,
      enabled: input.enabled,
      autoTickRequestFiredByUi: false,
      reason: 'persistent automation is polled by the local automation agent',
    });
    return;
  }

  const user = auth.currentUser;
  if (!user || user.uid !== input.carerUid) {
    logCarerStopAutomationAudit({
      action: auditAction,
      file: 'features/automation/automationAutoState.ts',
      function: 'setCarerAutomationAutoEnabled',
      carerUidFromProfile: carerUidFromProfile || null,
      uidFromSessionMe,
      firebaseCurrentUserUid,
      appSessionIdPrefix,
      role,
      sqlMode: false,
      authSource: 'firebase_current_user',
      willCallApi: false,
      reason: 'firebase_user_mismatch',
    });
    throw new Error('Not signed in as this carer.');
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
