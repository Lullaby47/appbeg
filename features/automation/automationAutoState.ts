import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { auth, getClientDb } from '@/lib/firebase/client';
import { logCarerPageRequestAudit } from '@/lib/client/carerPageRequestAudit';
import { logClientFirestoreSkipped, isClientSqlReadMode } from '@/lib/client/sqlReadMode';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import {
  attachHiddenTabPollResume,
  isDocumentHidden,
  logHiddenTabPollResumed,
} from '@/lib/client/hiddenTabPoll';
import { safetyIntervalWithJitter } from '@/lib/client/snapshotPollJitter';

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

const AUTO_STATE_VISIBLE_POLL_MS = 60_000;
const AUTO_STATE_HIDDEN_POLL_MS = 60_000;

function resolveAutoStatePollDelayMs() {
  if (isDocumentHidden()) {
    const delayMs = safetyIntervalWithJitter(AUTO_STATE_HIDDEN_POLL_MS);
    return { delayMs, throttled: true as const };
  }
  return {
    delayMs: safetyIntervalWithJitter(AUTO_STATE_VISIBLE_POLL_MS),
    throttled: false as const,
  };
}

const autoStatePollResumes = new Map<string, Set<() => void>>();

function registerAutoStatePollResume(carerUid: string, resume: () => void) {
  const key = String(carerUid || '').trim();
  if (!key) {
    return () => {};
  }
  const bucket = autoStatePollResumes.get(key) || new Set();
  bucket.add(resume);
  autoStatePollResumes.set(key, bucket);
  return () => {
    bucket.delete(resume);
    if (!bucket.size) {
      autoStatePollResumes.delete(key);
    }
  };
}

function notifyAutoStatePollResume(carerUid: string) {
  const key = String(carerUid || '').trim();
  if (!key) {
    return;
  }
  const bucket = autoStatePollResumes.get(key);
  if (!bucket) {
    return;
  }
  for (const resume of bucket) {
    resume();
  }
}

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
    console.info('[POLLING_INVENTORY]', {
      route: '/api/carer/automation-auto-state',
      intervalMs: AUTO_STATE_VISIBLE_POLL_MS,
      hiddenIntervalMs: AUTO_STATE_HIDDEN_POLL_MS,
      reason: 'automation_toggle_cross_tab_safety_check',
      trigger: 'subscribeCarerAutomationAutoState',
      canUseSSE: false,
      required: 'retained_as_slow_safety_poll_when_automation_enabled',
    });
    console.info('[POLLING_RETAINED]', {
      route: '/api/carer/automation-auto-state',
      reason: 'automation_auto_state_is_not_on_live_outbox_stream; poll only runs while automation is enabled',
      intervalMs: AUTO_STATE_VISIBLE_POLL_MS,
    });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let automationEnabled = false;
    let pollStarted = false;

    const scheduleNext = (reason: string) => {
      if (cancelled || !automationEnabled) {
        return;
      }
      const { delayMs, throttled } = resolveAutoStatePollDelayMs();
      if (throttled) {
        console.info('[CARER_AUTO_STATE_POLL_THROTTLED]', {
          carerUid,
          delayMs,
          reason,
        });
      }
      timer = setTimeout(() => {
        void tick('interval');
      }, delayMs);
    };

    const tick = async (reason: string) => {
      if (cancelled) {
        return;
      }
      if (!pollStarted) {
        pollStarted = true;
        console.info('[CARER_AUTO_STATE_POLL_STARTED]', { carerUid, reason });
      }
      try {
        const state = await fetchCarerAutomationAutoStateSql(carerUid);
        if (cancelled) {
          return;
        }
        automationEnabled = state?.enabled === true;
        onData(state);
        if (!automationEnabled) {
          console.info('[CARER_AUTO_STATE_POLL_SKIPPED]', {
            carerUid,
            reason: 'automation_disabled',
          });
          if (timer != null) {
            clearTimeout(timer);
            timer = null;
          }
          return;
        }
      } catch (error) {
        if (!cancelled) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (!cancelled && automationEnabled) {
          scheduleNext(reason);
        }
      }
    };

    const detachHiddenResume = attachHiddenTabPollResume('carer_automation_auto_state', () => {
      if (cancelled || !automationEnabled) {
        return;
      }
      logHiddenTabPollResumed('carer_automation_auto_state');
      console.info('[CARER_AUTO_STATE_POLL_RESUMED]', { carerUid, reason: 'hidden_tab' });
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      void tick('hidden_tab_resume');
    });
    const detachPollResume = registerAutoStatePollResume(carerUid, () => {
      if (cancelled) {
        return;
      }
      console.info('[CARER_AUTO_STATE_POLL_RESUMED]', { carerUid, reason: 'automation_enabled' });
      automationEnabled = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      void tick('automation_enabled');
    });

    void tick('initial');
    return () => {
      cancelled = true;
      detachHiddenResume();
      detachPollResume();
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

    if (input.enabled) {
      notifyAutoStatePollResume(carerUidFromProfile || uidFromSessionMe || input.carerUid);
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
