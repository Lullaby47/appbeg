import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  mapTaskType,
  resolveAutomationAccessFields,
  resolveTaskTypeLabel,
} from '@/lib/automation/automationClaimPayload';
import {
  claimCarerTaskAsAdmin,
  resolveCurrentUsernameForTask,
  resolveGameLoginDetailsForCoadminGame,
} from '@/lib/automation/carerClaimTaskAdmin';
import { AUTOMATION_AUTO_STATE_COLLECTION } from '@/features/automation/automationAutoState';
import { verifyAutoTickBrowserToken } from '@/lib/automation/autoTickBrowserToken';
import {
  apiError,
  requireCarerApiUser,
  type ApiUser,
  type ApiUserAuthPath,
} from '@/lib/firebase/apiAuth';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import {
  acquireAutomationAutoTickLeaseSql,
  disableAutomationAutoStateSql,
  lookupAutomationAutoStateFromSqlCache,
  mirrorAutomationAutoStateById,
  mirrorAutomationAutoStateSnapshot,
} from '@/lib/sql/automationAutoStateCache';
import {
  getPendingCarerTaskCandidatesFromSql,
  hasAutoTickTaskRecheckFields,
  lookupAutoTickTaskRecheckFromSql,
  mirrorCarerTaskById,
  type AutoTickPendingTaskCandidate,
} from '@/lib/sql/carerTasksCache';
import {
  lookupApiUserProfileFromSqlCache,
  mirrorPlayerById,
} from '@/lib/sql/playersCache';

const LEASE_TTL_MS = 70_000;
const MAX_CLAIMS_PER_TICK = 5;
const PENDING_QUERY_LIMIT = 15;

function logAutoTickTiming(step: string, startedAt: number, details: Record<string, unknown> = {}) {
  console.info(`[AUTO_TICK_TIMING] ${step}`, {
    durationMs: Date.now() - startedAt,
    ...details,
  });
}

function isAgentSupportedAutomationType(value: string) {
  return (
    value === 'CREATE_USERNAME' ||
    value === 'RESET_PASSWORD' ||
    value === 'RECHARGE' ||
    value === 'REDEEM'
  );
}

function validateAutomationAgentId(agentId: string): {
  valid: boolean;
  normalized?: string;
} {
  const trimmed = String(agentId || '').trim();
  if (!trimmed || trimmed.length > 64) {
    return { valid: false };
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    return { valid: false };
  }
  return { valid: true, normalized: trimmed };
}

type AutoTickCarerProfile = {
  username: string;
  coadminUid: string;
  automationAgentId: string;
};

type AutoTickAuthSource = 'api_user_sql' | 'api_user_sql_session_sql' | 'firestore_fallback';

function mapAutoTickAuthSource(authPath: ApiUserAuthPath | null): AutoTickAuthSource {
  if (
    authPath === 'api_user_sql' ||
    authPath === 'carer_token_sql' ||
    authPath === 'carer_app_session_sql' ||
    authPath === 'app_session_sql'
  ) {
    return 'api_user_sql';
  }
  if (authPath === 'api_user_sql_session_sql' || authPath === 'app_session_sql_session_sql') {
    return 'api_user_sql_session_sql';
  }
  return 'firestore_fallback';
}

function carerProfileFieldsFromApiUser(user: ApiUser) {
  return {
    role: user.role,
    username: String(user.username || '').trim(),
    coadminUid: String(user.coadminUid || user.createdBy || '').trim(),
    automationAgentId: String(user.automationAgentId || '').trim(),
  };
}

function carerProfileFromSqlProfile(profile: {
  role: string;
  username: string;
  coadminUid: string | null;
  createdBy: string | null;
  automationAgentId: string | null;
}): AutoTickCarerProfile {
  return {
    username: String(profile.username || '').trim(),
    coadminUid: String(profile.coadminUid || profile.createdBy || '').trim(),
    automationAgentId: String(profile.automationAgentId || '').trim(),
  };
}

function hasAutoTickCarerProfileFields(fields: {
  role: string;
  coadminUid: string;
  automationAgentId: string;
}) {
  return (
    String(fields.role || '').toLowerCase() === 'carer' &&
    Boolean(fields.coadminUid) &&
    Boolean(fields.automationAgentId)
  );
}

async function resolveAutoTickCarerProfile(params: {
  carerUid: string;
  authUser: ApiUser | null;
  authPath: ApiUserAuthPath | null;
}): Promise<
  | { ok: true; profile: AutoTickCarerProfile; authSource: AutoTickAuthSource }
  | { ok: false; response: NextResponse }
> {
  const { carerUid, authUser, authPath } = params;
  const userReadStartedAt = Date.now();

  if (authUser) {
    const fields = carerProfileFieldsFromApiUser(authUser);
    if (!hasAutoTickCarerProfileFields(fields)) {
      logAutoTickTiming('user_read_fallback', userReadStartedAt, {
        carerUid,
        reason: 'missing_field',
        missingAutomationAgentId: !fields.automationAgentId,
        missingCoadminUid: !fields.coadminUid,
        role: fields.role,
      });
    } else {
      logAutoTickTiming('user_read', userReadStartedAt, {
        carerUid,
        skipped: true,
        source: authPath === 'api_user_sql' ? 'auth_sql' : 'auth_user',
        durationMs: 0,
      });
      const authSource = mapAutoTickAuthSource(authPath);
      console.info('[AUTO_TICK_AUTH_SOURCE] source=%s authPath=%s', authSource, authPath);
      return {
        ok: true,
        profile: {
          username: fields.username,
          coadminUid: fields.coadminUid,
          automationAgentId: fields.automationAgentId,
        },
        authSource,
      };
    }
  }

  const sqlLookup = await lookupApiUserProfileFromSqlCache(carerUid);
  if (sqlLookup.profile) {
    const fields = {
      role: sqlLookup.profile.role,
      coadminUid: String(sqlLookup.profile.coadminUid || sqlLookup.profile.createdBy || '').trim(),
      automationAgentId: String(sqlLookup.profile.automationAgentId || '').trim(),
    };
    if (hasAutoTickCarerProfileFields(fields)) {
      logAutoTickTiming('user_read', userReadStartedAt, {
        carerUid,
        skipped: true,
        source: 'sql_cache',
        durationMs: Date.now() - userReadStartedAt,
      });
      console.info('[AUTO_TICK_AUTH_SOURCE] source=%s authPath=%s', 'api_user_sql', authPath);
      return {
        ok: true,
        profile: carerProfileFromSqlProfile(sqlLookup.profile),
        authSource: 'api_user_sql',
      };
    }
    logAutoTickTiming('user_read_fallback', userReadStartedAt, {
      carerUid,
      reason: 'missing_field',
      sqlRole: sqlLookup.profile.role,
      missingAutomationAgentId: !fields.automationAgentId,
      missingCoadminUid: !fields.coadminUid,
    });
  } else if (sqlLookup.missReason) {
    logAutoTickTiming('user_read_fallback', userReadStartedAt, {
      carerUid,
      reason: 'sql_miss',
      missReason: sqlLookup.missReason,
    });
  }

  if (isAuthSqlReadEnabled()) {
    const reason = sqlLookup.missReason || 'row_missing';
    console.info('[AUTO_TICK_AUTH_SOURCE] source=sql_blocked authPath=%s firestore_fallback=false reason=%s', authPath, reason);
    if (reason === 'postgres_unavailable' || reason === 'lookup_failed') {
      return {
        ok: false,
        response: apiError('SQL auth is unavailable. Configure DATABASE_URL on the server.', 503),
      };
    }
    return { ok: false, response: apiError('Carer profile not found in SQL cache.', 404) };
  }

  const userSnap = await adminDb.collection('users').doc(carerUid).get();
  logAutoTickTiming('user_read', userReadStartedAt, {
    carerUid,
    exists: userSnap.exists,
    skipped: false,
    durationMs: Date.now() - userReadStartedAt,
  });
  if (!userSnap.exists) {
    return { ok: false, response: apiError('User not found.', 404) };
  }

  const userData = userSnap.data() as {
    automationAgentId?: string | null;
    username?: string | null;
    role?: string | null;
    coadminUid?: string | null;
    createdBy?: string | null;
  };
  if (String(userData.role || '').toLowerCase() !== 'carer') {
    return {
      ok: false,
      response: apiError('Automation auto-tick is only available for carer accounts.', 403),
    };
  }

  try {
    await mirrorPlayerById(carerUid, 'automation_auto_tick_hydrate');
  } catch (error) {
    logAutoTickTiming('user_read_fallback', userReadStartedAt, {
      carerUid,
      reason: 'hydrate_failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  console.info('[AUTO_TICK_AUTH_SOURCE] source=%s authPath=%s', 'firestore_fallback', authPath);
  return {
    ok: true,
    profile: {
      username: String(userData.username || '').trim(),
      coadminUid:
        String(userData.coadminUid || '').trim() || String(userData.createdBy || '').trim(),
      automationAgentId: String(userData.automationAgentId || '').trim(),
    },
    authSource: 'firestore_fallback',
  };
}

type AutoTickStateTiming = {
  state_source: 'sql' | 'firestore';
  state_sql_ms: number;
  state_doc_ms: number;
  lease_source: 'sql' | 'firestore' | 'skipped';
  lease_sql_ms: number;
  lease_transaction_ms: number;
};

function createAutoTickStateTiming(): AutoTickStateTiming {
  return {
    state_source: 'firestore',
    state_sql_ms: 0,
    state_doc_ms: 0,
    lease_source: 'skipped',
    lease_sql_ms: 0,
    lease_transaction_ms: 0,
  };
}

async function acquireAutomationAutoTickLeaseFirestore(
  stateRef: DocumentReference,
  instanceId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef);
      if (!snap.exists) {
        throw new Error('STATE_GONE');
      }
      const d = snap.data() as {
        enabled?: boolean;
        tickLeaseHolderId?: string;
        tickLeaseExpiresAt?: { toMillis?: () => number } | null;
      };
      if (!d.enabled) {
        throw new Error('DISABLED');
      }
      const now = Date.now();
      const exp =
        typeof d.tickLeaseExpiresAt?.toMillis === 'function'
          ? d.tickLeaseExpiresAt.toMillis()
          : 0;
      const holder = String(d.tickLeaseHolderId || '');
      if (holder && holder !== instanceId && exp > now) {
        throw new Error('LEASE_HELD');
      }
      tx.update(stateRef, {
        tickLeaseHolderId: instanceId,
        tickLeaseExpiresAt: Timestamp.fromMillis(now + LEASE_TTL_MS),
        automationTickLastAt: FieldValue.serverTimestamp(),
      });
    });
    void mirrorAutomationAutoStateById(stateRef.id, 'automation_auto_tick_lease_hydrate');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function resolveAutomationAutoTickState(
  carerUid: string,
  stateRef: DocumentReference,
  stateTiming: AutoTickStateTiming
): Promise<
  | {
      ok: true;
      enabled: boolean;
      stateExists: boolean;
      stateCoadminUidIgnored: string | null;
      usedSqlState: boolean;
    }
  | { ok: false; response: NextResponse }
> {
  const stateReadStartedAt = Date.now();
  const sqlStateLookup = await lookupAutomationAutoStateFromSqlCache(carerUid);
  stateTiming.state_sql_ms = Date.now() - stateReadStartedAt;

  if (sqlStateLookup.state) {
    stateTiming.state_source = 'sql';
    logAutoTickTiming('state_read', stateReadStartedAt, {
      carerUid,
      exists: true,
      state_source: stateTiming.state_source,
      state_sql_ms: stateTiming.state_sql_ms,
      state_doc_ms: 0,
      enabled: sqlStateLookup.state.enabled,
    });
    return {
      ok: true,
      enabled: sqlStateLookup.state.enabled,
      stateExists: true,
      stateCoadminUidIgnored: sqlStateLookup.state.coadminUid,
      usedSqlState: true,
    };
  }

  if (sqlStateLookup.missReason) {
    console.info(
      '[AUTO_TICK_STATE_FALLBACK] reason=%s carerUid=%s firestore_fallback=%s',
      sqlStateLookup.missReason,
      carerUid,
      !isAuthSqlReadEnabled()
    );
  }

  if (isAuthSqlReadEnabled()) {
    stateTiming.state_source = 'sql';
    logAutoTickTiming('state_read', stateReadStartedAt, {
      carerUid,
      exists: false,
      state_source: stateTiming.state_source,
      state_sql_ms: stateTiming.state_sql_ms,
      state_doc_ms: 0,
      firestore_fallback: false,
      missReason: sqlStateLookup.missReason || 'row_missing',
    });
    return {
      ok: true,
      enabled: false,
      stateExists: false,
      stateCoadminUidIgnored: null,
      usedSqlState: true,
    };
  }

  const stateDocStartedAt = Date.now();
  const stateSnap = await stateRef.get();
  stateTiming.state_doc_ms = Date.now() - stateDocStartedAt;
  stateTiming.state_source = 'firestore';
  logAutoTickTiming('state_read', stateReadStartedAt, {
    carerUid,
    exists: stateSnap.exists,
    state_source: stateTiming.state_source,
    state_sql_ms: stateTiming.state_sql_ms,
    state_doc_ms: stateTiming.state_doc_ms,
  });

  if (stateSnap.exists) {
    try {
      const mirrored = await mirrorAutomationAutoStateSnapshot(
        stateSnap,
        'automation_auto_tick_state_hydrate'
      );
      if (!mirrored) {
        console.info(
          '[AUTO_TICK_STATE_FALLBACK] reason=hydrate_failed carerUid=%s context=state_read',
          carerUid
        );
      }
    } catch (error) {
      console.info(
        '[AUTO_TICK_STATE_FALLBACK] reason=hydrate_failed carerUid=%s error=%s context=state_read',
        carerUid,
        error
      );
    }
  }

  const state = stateSnap.exists
    ? (stateSnap.data() as { enabled?: boolean; coadminUid?: string })
    : null;

  return {
    ok: true,
    enabled: Boolean(state?.enabled),
    stateExists: stateSnap.exists,
    stateCoadminUidIgnored: String(state?.coadminUid || '').trim() || null,
    usedSqlState: false,
  };
}

type AutoTickPendingTiming = {
  pending_source: 'sql' | 'firestore';
  pending_sql_ms: number;
  pending_firestore_ms: number;
};

async function resolveAutoTickPendingCandidates(
  coadminUid: string,
  carerUid: string,
  limit: number
): Promise<{
  candidates: AutoTickPendingTaskCandidate[];
  timing: AutoTickPendingTiming;
}> {
  const sqlStartedAt = Date.now();
  const sqlResult = await getPendingCarerTaskCandidatesFromSql(coadminUid, limit, carerUid);
  const pending_sql_ms = Date.now() - sqlStartedAt;

  if (sqlResult.hit) {
    return {
      candidates: sqlResult.candidates,
      timing: {
        pending_source: 'sql',
        pending_sql_ms,
        pending_firestore_ms: 0,
      },
    };
  }

  console.info(
    '[AUTO_TICK_PENDING_FALLBACK] reason=%s coadminUid=%s carerUid=%s firestore_fallback=%s',
    sqlResult.missReason || 'lookup_failed',
    coadminUid,
    carerUid,
    !isAuthSqlReadEnabled()
  );

  if (isAuthSqlReadEnabled()) {
    return {
      candidates: [],
      timing: {
        pending_source: 'sql',
        pending_sql_ms,
        pending_firestore_ms: 0,
      },
    };
  }

  const firestoreStartedAt = Date.now();
  const pendingSnap = await adminDb
    .collection('carerTasks')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const pending_firestore_ms = Date.now() - firestoreStartedAt;

  const candidates = pendingSnap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Record<string, unknown>),
  }));

  return {
    candidates,
    timing: {
      pending_source: 'firestore',
      pending_sql_ms,
      pending_firestore_ms,
    },
  };
}

function taskDebugFields(task: Record<string, unknown>) {
  return {
    status: String(task['status'] || '').trim() || null,
    assignedCarerUid: String(task['assignedCarerUid'] || '').trim() || null,
    assignedCarerUsername: String(task['assignedCarerUsername'] || task['assignedCarer'] || '').trim() || null,
    claimedByUid: String(task['claimedByUid'] || '').trim() || null,
    automationJobId: String(task['automationJobId'] || '').trim() || null,
  };
}

type AutoTickTaskRecheckTiming = {
  task_recheck_source: 'candidate' | 'sql' | 'firestore' | 'none';
  task_recheck_sql_ms: number;
  task_recheck_firestore_ms: number;
};

async function resolveAutoTickTaskRecheck(
  taskId: string,
  candidateTask: AutoTickPendingTaskCandidate,
  pendingSource: AutoTickPendingTiming['pending_source']
): Promise<{
  latestFields: ReturnType<typeof taskDebugFields> | null;
  timing: AutoTickTaskRecheckTiming;
}> {
  const timing: AutoTickTaskRecheckTiming = {
    task_recheck_source: 'none',
    task_recheck_sql_ms: 0,
    task_recheck_firestore_ms: 0,
  };

  if (hasAutoTickTaskRecheckFields(candidateTask)) {
    timing.task_recheck_source = 'candidate';
    console.info('[AUTO_TICK_TASK_RECHECK_SQL]', {
      taskId,
      source: 'candidate',
      pending_source: pendingSource,
      durationMs: 0,
    });
    return {
      latestFields: taskDebugFields(candidateTask),
      timing,
    };
  }

  const sqlStartedAt = Date.now();
  const sqlResult = await lookupAutoTickTaskRecheckFromSql(taskId);
  timing.task_recheck_sql_ms = Date.now() - sqlStartedAt;

  if (sqlResult.hit && sqlResult.task) {
    timing.task_recheck_source = 'sql';
    console.info('[AUTO_TICK_TASK_RECHECK_SQL]', {
      taskId,
      source: 'sql',
      pending_source: pendingSource,
      durationMs: timing.task_recheck_sql_ms,
      pool_acquire_ms: sqlResult.timing.pool_acquire_ms,
      query_exec_ms: sqlResult.timing.query_exec_ms,
    });
    return {
      latestFields: taskDebugFields(sqlResult.task),
      timing,
    };
  }

  if (isAuthSqlReadEnabled()) {
    timing.task_recheck_source = 'sql';
    console.info('[AUTO_TICK_TASK_RECHECK_SQL]', {
      taskId,
      source: 'sql_miss',
      pending_source: pendingSource,
      durationMs: timing.task_recheck_sql_ms,
      sql_miss_reason: sqlResult.missReason,
      firestore_fallback: false,
    });
    return {
      latestFields: null,
      timing,
    };
  }

  const firestoreStartedAt = Date.now();
  const latestTaskSnap = await adminDb.collection('carerTasks').doc(taskId).get();
  timing.task_recheck_firestore_ms = Date.now() - firestoreStartedAt;
  timing.task_recheck_source = 'firestore';
  const latestTask = latestTaskSnap.exists
    ? (latestTaskSnap.data() as Record<string, unknown>)
    : null;
  console.info('[AUTO_TICK_TASK_RECHECK_FALLBACK]', {
    taskId,
    pending_source: pendingSource,
    durationMs: timing.task_recheck_firestore_ms,
    sql_miss_reason: sqlResult.missReason,
    exists: latestTaskSnap.exists,
  });
  return {
    latestFields: latestTask ? taskDebugFields(latestTask) : null,
    timing,
  };
}

export async function POST(request: Request) {
  const routeStartedAt = Date.now();
  console.info('[AUTO_TICK] route called', {
    hasSecretHeader: Boolean(String(request.headers.get('x-carer-automation-tick-secret') || '').trim()),
    hasAuthorization: Boolean(String(request.headers.get('Authorization') || '').trim()),
  });

  let body: { carerUid?: unknown; agentId?: unknown; instanceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return apiError('Invalid JSON body.', 400);
  }

  const carerUid = String(body.carerUid || '').trim();
  const agentId = String(body.agentId || '').trim();
  const instanceId = String(body.instanceId || '').trim();
  if (!carerUid || !agentId || !instanceId) {
    return apiError('carerUid, agentId, and instanceId are required.', 400);
  }

  const expected = String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim();
  const provided = String(request.headers.get('x-carer-automation-tick-secret') || '').trim();
  const browserToken = String(request.headers.get('x-carer-auto-tick-token') || '').trim();
  const hasValidSecret = Boolean(expected && provided && provided === expected);
  const authStartedAt = Date.now();
  const tokenCheck = !hasValidSecret && browserToken ? verifyAutoTickBrowserToken(browserToken) : null;
  const hasValidBrowserToken =
    Boolean(tokenCheck?.ok) &&
    tokenCheck?.ok === true &&
    tokenCheck.payload.carerUid === carerUid &&
    tokenCheck.payload.automationAgentId === agentId;
  const auth = hasValidSecret || hasValidBrowserToken
    ? null
    : await requireCarerApiUser(request);
  logAutoTickTiming('auth', authStartedAt, {
    authMode: hasValidSecret ? 'secret' : hasValidBrowserToken ? 'browser_token' : 'firebase',
    ok: !(auth && 'response' in auth),
    tokenReason: tokenCheck && !tokenCheck.ok ? tokenCheck.reason : null,
  });
  if (auth && 'response' in auth) {
    return auth.response;
  }
  if (auth && 'user' in auth && auth.user.uid !== carerUid) {
    return apiError('Forbidden: cannot tick automation for another carer.', 403);
  }

  const profileResult = await resolveAutoTickCarerProfile({
    carerUid,
    authUser: auth && 'user' in auth ? auth.user : null,
    authPath: auth && 'authPath' in auth ? auth.authPath : null,
  });
  if (!profileResult.ok) {
    return profileResult.response;
  }
  const { profile: carerProfile } = profileResult;
  const coadminUid = carerProfile.coadminUid;
  if (!coadminUid) {
    console.info('[AUTO_TICK] skipped auto tick', {
      carerUid,
      reason: 'missing_profile_coadmin_uid',
    });
    return NextResponse.json({ ok: true, claimed: false, reason: 'missing_coadmin_uid' });
  }
  console.info('[AUTO_TICK] request received', {
    carerUid,
    carerUsername: carerProfile.username || null,
    agentId,
    instanceId,
  });
  const linked = validateAutomationAgentId(carerProfile.automationAgentId);
  const bodyAgent = validateAutomationAgentId(agentId);
  if (
    !linked.valid ||
    !linked.normalized ||
    !bodyAgent.valid ||
    !bodyAgent.normalized ||
    linked.normalized !== bodyAgent.normalized
  ) {
    return apiError('agentId does not match the linked automation agent for this carer.', 403);
  }

  const stateRef = adminDb.collection(AUTOMATION_AUTO_STATE_COLLECTION).doc(carerUid);
  const stateTiming = createAutoTickStateTiming();
  const stateResult = await resolveAutomationAutoTickState(carerUid, stateRef, stateTiming);
  if (!stateResult.ok) {
    return stateResult.response;
  }
  console.info('[AUTO_TICK] automation enabled state', {
    carerUid,
    carerUsername: carerProfile.username || null,
    stateExists: stateResult.stateExists,
    enabled: stateResult.enabled,
    stateCoadminUidIgnored: stateResult.stateCoadminUidIgnored,
    coadminUid,
    state_source: stateTiming.state_source,
  });
  if (!stateResult.enabled) {
    console.info('[AUTO_TICK] skipped auto tick', {
      carerUid,
      reason: 'automation_disabled',
    });
    return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
  }

  const leaseStartedAt = Date.now();
  const isBrowserAutoTick = !hasValidSecret && instanceId.startsWith('carer-ui-');
  if (isBrowserAutoTick) {
    stateTiming.lease_source = 'skipped';
    logAutoTickTiming('lease_transaction', leaseStartedAt, {
      carerUid,
      coadminUid,
      instanceId,
      acquired: true,
      skipped: true,
      mode: 'browser_claim_transaction_guard',
      lease_source: stateTiming.lease_source,
      lease_sql_ms: 0,
      lease_transaction_ms: 0,
    });
  } else if (stateResult.usedSqlState) {
    const sqlLeaseResult = await acquireAutomationAutoTickLeaseSql(
      carerUid,
      instanceId,
      LEASE_TTL_MS
    );
    stateTiming.lease_sql_ms = sqlLeaseResult.timing.total_ms;
    if (sqlLeaseResult.ok) {
      stateTiming.lease_source = 'sql';
      logAutoTickTiming('lease_transaction', leaseStartedAt, {
        carerUid,
        coadminUid,
        instanceId,
        acquired: true,
        mode: 'sql',
        lease_source: stateTiming.lease_source,
        lease_sql_ms: stateTiming.lease_sql_ms,
        lease_transaction_ms: 0,
      });
    } else if (
      sqlLeaseResult.reason === 'postgres_unavailable' ||
      sqlLeaseResult.reason === 'lookup_failed'
    ) {
      console.info(
        '[AUTO_TICK_STATE_FALLBACK] reason=%s carerUid=%s context=lease',
        sqlLeaseResult.reason,
        carerUid
      );
      const firestoreLease = await acquireAutomationAutoTickLeaseFirestore(stateRef, instanceId);
      stateTiming.lease_transaction_ms = Date.now() - leaseStartedAt;
      stateTiming.lease_source = 'firestore';
      logAutoTickTiming('lease_transaction', leaseStartedAt, {
        carerUid,
        coadminUid,
        instanceId,
        acquired: firestoreLease.ok,
        mode: 'transaction',
        lease_source: stateTiming.lease_source,
        lease_sql_ms: stateTiming.lease_sql_ms,
        lease_transaction_ms: stateTiming.lease_transaction_ms,
        error: firestoreLease.ok ? null : firestoreLease.reason,
      });
      if (!firestoreLease.ok) {
        const msg = firestoreLease.reason;
        if (msg === 'LEASE_HELD') {
          console.info('[AUTO_TICK] skipped auto tick', {
            carerUid,
            reason: 'lease_held',
            instanceId,
          });
          return NextResponse.json({ ok: true, claimed: false, reason: 'lease_held' });
        }
        if (msg === 'DISABLED' || msg === 'STATE_GONE') {
          console.info('[AUTO_TICK] skipped auto tick', {
            carerUid,
            reason: msg === 'STATE_GONE' ? 'state_gone' : 'disabled_during_lease',
          });
          return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
        }
        throw new Error(msg);
      }
    } else {
      stateTiming.lease_source = 'sql';
      logAutoTickTiming('lease_transaction', leaseStartedAt, {
        carerUid,
        coadminUid,
        instanceId,
        acquired: false,
        mode: 'sql',
        lease_source: stateTiming.lease_source,
        lease_sql_ms: stateTiming.lease_sql_ms,
        lease_transaction_ms: 0,
        error: sqlLeaseResult.reason,
      });
      if (sqlLeaseResult.reason === 'LEASE_HELD') {
        console.info('[AUTO_TICK] skipped auto tick', {
          carerUid,
          reason: 'lease_held',
          instanceId,
        });
        return NextResponse.json({ ok: true, claimed: false, reason: 'lease_held' });
      }
      if (sqlLeaseResult.reason === 'DISABLED' || sqlLeaseResult.reason === 'STATE_GONE') {
        console.info('[AUTO_TICK] skipped auto tick', {
          carerUid,
          reason:
            sqlLeaseResult.reason === 'STATE_GONE' ? 'state_gone' : 'disabled_during_lease',
        });
        return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
      }
    }
  } else {
    const firestoreLease = await acquireAutomationAutoTickLeaseFirestore(stateRef, instanceId);
    stateTiming.lease_transaction_ms = Date.now() - leaseStartedAt;
    stateTiming.lease_source = 'firestore';
    logAutoTickTiming('lease_transaction', leaseStartedAt, {
      carerUid,
      coadminUid,
      instanceId,
      acquired: firestoreLease.ok,
      mode: 'transaction',
      lease_source: stateTiming.lease_source,
      lease_sql_ms: 0,
      lease_transaction_ms: stateTiming.lease_transaction_ms,
      error: firestoreLease.ok ? null : firestoreLease.reason,
    });
    if (!firestoreLease.ok) {
      const msg = firestoreLease.reason;
      if (msg === 'LEASE_HELD') {
        console.info('[AUTO_TICK] skipped auto tick', {
          carerUid,
          reason: 'lease_held',
          instanceId,
        });
        return NextResponse.json({ ok: true, claimed: false, reason: 'lease_held' });
      }
      if (msg === 'DISABLED' || msg === 'STATE_GONE') {
        console.info('[AUTO_TICK] skipped auto tick', {
          carerUid,
          reason: msg === 'STATE_GONE' ? 'state_gone' : 'disabled_during_lease',
        });
        return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
      }
      throw new Error(msg);
    }
  }

  const inProgressStartedAt = Date.now();
  logAutoTickTiming('in_progress_query', inProgressStartedAt, {
    carerUid,
    coadminUid,
    resultCount: 0,
    skipped: true,
    reason: 'diagnostic_only_not_required_for_claim',
  });

  console.info('[AUTO_TICK] pending candidates and in-progress snapshot', {
    carerUid,
    carerUsername: carerProfile.username || null,
    coadminUid,
    maxClaimsPerTick: MAX_CLAIMS_PER_TICK,
    pendingQueryLimit: PENDING_QUERY_LIMIT,
    inProgressPoolCount: null,
    myInProgressCount: null,
    myInProgressTaskIds: [],
    inProgressSnapshotSkipped: true,
  });

  const pendingStartedAt = Date.now();
  const pendingResult = await resolveAutoTickPendingCandidates(
    coadminUid,
    carerUid,
    PENDING_QUERY_LIMIT
  );
  const pendingCandidates = pendingResult.candidates;
  logAutoTickTiming('pending_query', pendingStartedAt, {
    carerUid,
    coadminUid,
    resultCount: pendingCandidates.length,
    pending_source: pendingResult.timing.pending_source,
    pending_sql_ms: pendingResult.timing.pending_sql_ms,
    pending_firestore_ms: pendingResult.timing.pending_firestore_ms,
  });

  console.info('[AUTO_TICK] pending query result', {
    carerUid,
    coadminUid,
    candidateCount: pendingCandidates.length,
    candidateTaskIds: pendingCandidates.map((task) => task.id),
    pending_source: pendingResult.timing.pending_source,
  });

  const claimedJobs: Array<{
    taskId: string;
    jobId: string;
    reusedExistingJob: boolean;
  }> = [];
  const skippedTasks: Array<{
    taskId: string;
    reason: string;
    message?: string;
    mapped?: string;
  }> = [];

  for (const task of pendingCandidates) {
    const taskId = task.id;
    if (claimedJobs.length >= MAX_CLAIMS_PER_TICK) {
      console.info('[AUTO_TICK] claim batch limit reached', {
        carerUid,
        coadminUid,
        claimedCount: claimedJobs.length,
        maxClaimsPerTick: MAX_CLAIMS_PER_TICK,
      });
      break;
    }

    console.info('[AUTO_TICK] pending task from query', {
      taskId,
      fields: taskDebugFields(task),
      pending_source: pendingResult.timing.pending_source,
    });
    const mapped = mapTaskType(resolveTaskTypeLabel(task));
    if (!isAgentSupportedAutomationType(mapped)) {
      console.info('[AUTO_TICK] skipped task (unsupported type)', {
        taskId,
        reason: 'unsupported_automation_type',
        mapped,
      });
      skippedTasks.push({
        taskId,
        reason: 'unsupported_automation_type',
        mapped,
      });
      continue;
    }
    const gameName = String(task['gameName'] || task['game'] || '').trim();
    const playerUid = String(task['playerUid'] || '').trim();
    if (!gameName || !playerUid) {
      console.info('[AUTO_TICK] skipped task (missing game or player)', {
        taskId,
        reason: 'missing_game_or_player',
      });
      skippedTasks.push({
        taskId,
        reason: 'missing_game_or_player',
      });
      continue;
    }

    const taskAccess = resolveAutomationAccessFields(task);
    const hasEmbeddedGameLoginDetails = Boolean(
      taskAccess.loginUrl &&
        taskAccess.gameCredentialUsername &&
        taskAccess.gameCredentialPassword
    );
    const gameLoginStartedAt = Date.now();
    const gameLoginDetails = hasEmbeddedGameLoginDetails
      ? null
      : await resolveGameLoginDetailsForCoadminGame(coadminUid, gameName);
    if (hasEmbeddedGameLoginDetails) {
      console.info(
        '[AUTO_TICK_RESOLVER_SQL] type=game_login hit=true source=task_embedded durationMs=0 coadminUid=%s playerUid=%s gameName=%s taskId=%s',
        coadminUid,
        playerUid,
        gameName,
        taskId
      );
    }
    logAutoTickTiming('resolve_game_login_details', gameLoginStartedAt, {
      taskId,
      coadminUid,
      gameName,
      found: Boolean(gameLoginDetails) || hasEmbeddedGameLoginDetails,
      skipped: hasEmbeddedGameLoginDetails,
      reason: hasEmbeddedGameLoginDetails ? 'task_already_has_access_fields' : null,
    });
    const embeddedCurrentUsername =
      String(
        (typeof task['currentUsername'] === 'string' ? task['currentUsername'] : '') ||
          (typeof task['gameAccountUsername'] === 'string' ? task['gameAccountUsername'] : '') ||
          ''
      ).trim() || null;
    const usernameStartedAt = Date.now();
    const fromLogin = embeddedCurrentUsername
      ? null
      : await resolveCurrentUsernameForTask(coadminUid, playerUid, gameName);
    if (embeddedCurrentUsername) {
      console.info(
        '[AUTO_TICK_RESOLVER_SQL] type=username hit=true source=task_embedded durationMs=0 coadminUid=%s playerUid=%s gameName=%s taskId=%s',
        coadminUid,
        playerUid,
        gameName,
        taskId
      );
    }
    logAutoTickTiming('resolve_current_username', usernameStartedAt, {
      taskId,
      coadminUid,
      playerUid,
      gameName,
      found: Boolean(fromLogin || embeddedCurrentUsername),
      skipped: Boolean(embeddedCurrentUsername),
      reason: embeddedCurrentUsername ? 'task_already_has_current_username' : null,
    });
    const currentUsername =
      embeddedCurrentUsername ||
      fromLogin ||
      null;

    const carerName = carerProfile.username || 'Carer';

    console.info('[AUTO_TICK] attempting claim for pending task', {
      taskId,
      selectedTaskId: taskId,
      gameName,
      playerUid,
      beforeFields: taskDebugFields(task),
    });

    const claimStartedAt = Date.now();
    try {
      const result = await claimCarerTaskAsAdmin({
        carerUid,
        carerCoadminUid: coadminUid,
        taskId,
        currentUsername,
        carerName,
        gameLoginDetails,
        trustedUser: {
          username: carerProfile.username || null,
          automationAgentId: linked.normalized,
        },
      });
      logAutoTickTiming('claimCarerTaskAsAdmin_total', claimStartedAt, {
        taskId,
        carerUid,
        ok: true,
        jobId: result.jobId,
        reusedExistingJob: result.reusedExistingJob,
      });
      console.info('[AUTO_TICK] claimed pending task as in_progress', {
        taskId: result.taskId,
        jobId: result.jobId,
        carerUid,
        reusedExistingJob: result.reusedExistingJob,
        automationJobCreated: !result.reusedExistingJob,
        originalTaskUpdatedToInProgress: true,
      });
      void mirrorCarerTaskById(result.taskId, 'appbeg_automation_auto_tick');
      claimedJobs.push({
        taskId: result.taskId,
        jobId: result.jobId,
        reusedExistingJob: result.reusedExistingJob,
      });
    } catch (err) {
      logAutoTickTiming('claimCarerTaskAsAdmin_total', claimStartedAt, {
        taskId,
        carerUid,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('Automation job already exists') ||
        message.includes('Task already claimed') ||
        message.includes('not reclaimable') ||
        message.includes('unsupported') ||
        message.includes('No automation agent')
      ) {
        const taskRecheck = await resolveAutoTickTaskRecheck(
          taskId,
          task,
          pendingResult.timing.pending_source
        );
        console.info('[AUTO_TICK] skipped task after claim attempt', {
          taskId,
          reason: 'claim_rejected',
          message,
          latestFields: taskRecheck.latestFields,
          task_recheck_source: taskRecheck.timing.task_recheck_source,
          task_recheck_sql_ms: taskRecheck.timing.task_recheck_sql_ms,
          task_recheck_firestore_ms: taskRecheck.timing.task_recheck_firestore_ms,
        });
        skippedTasks.push({
          taskId,
          reason: 'claim_rejected',
          message,
        });
        continue;
      }
      const lower = message.toLowerCase();
      if (lower.includes('resource_exhausted') || lower.includes('quota exceeded')) {
        await stateRef.set(
          {
            enabled: false,
            updatedAt: FieldValue.serverTimestamp(),
            stoppedAt: FieldValue.serverTimestamp(),
            autoDisabledReason: 'firestore_quota',
          },
          { merge: true }
        );
        void disableAutomationAutoStateSql(carerUid, 'firestore_quota');
        void mirrorAutomationAutoStateById(carerUid, 'automation_auto_tick_quota_hydrate');
        return NextResponse.json({ ok: false, claimed: false, reason: 'quota', error: message }, { status: 429 });
      }
      console.error('[AUTO_TICK] unexpected claim error', { taskId, message });
      return NextResponse.json({ ok: false, claimed: false, error: message }, { status: 500 });
    }
  }

  if (claimedJobs.length > 0) {
    console.info('[AUTO_TICK] claim batch complete', {
      carerUid,
      coadminUid,
      claimedCount: claimedJobs.length,
      claimedTaskIds: claimedJobs.map((job) => job.taskId),
      claimedJobIds: claimedJobs.map((job) => job.jobId),
      skippedCount: skippedTasks.length,
      skippedTasks,
    });
    logAutoTickTiming('total', routeStartedAt, {
      carerUid,
      coadminUid,
      claimed: true,
      claimedCount: claimedJobs.length,
      skippedCount: skippedTasks.length,
    });
    return NextResponse.json({
      ok: true,
      claimed: true,
      claimedCount: claimedJobs.length,
      claimedJobs,
      claimedTaskIds: claimedJobs.map((job) => job.taskId),
      claimedJobIds: claimedJobs.map((job) => job.jobId),
      skippedCount: skippedTasks.length,
      skippedTasks,
      taskId: claimedJobs[0]?.taskId || null,
      jobId: claimedJobs[0]?.jobId || null,
      reusedExistingJob: claimedJobs[0]?.reusedExistingJob || false,
    });
  }

  console.info('[AUTO_TICK] no claimable pending task after scanning candidates', {
    candidateCount: pendingCandidates.length,
    skippedCount: skippedTasks.length,
    skippedTasks,
  });
  logAutoTickTiming('total', routeStartedAt, {
    carerUid,
    coadminUid,
    claimed: false,
    claimedCount: 0,
    skippedCount: skippedTasks.length,
    reason: 'no_claimable_task',
  });
  return NextResponse.json({
    ok: true,
    claimed: false,
    claimedCount: 0,
    claimedJobs: [],
    claimedTaskIds: [],
    claimedJobIds: [],
    skippedCount: skippedTasks.length,
    skippedTasks,
    reason: 'no_claimable_task',
  });
}
