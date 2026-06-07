import { FieldValue, Timestamp } from 'firebase-admin/firestore';
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
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { mirrorCarerTaskById } from '@/lib/sql/carerTasksCache';

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

function taskDebugFields(task: Record<string, unknown>) {
  return {
    status: String(task['status'] || '').trim() || null,
    assignedCarerUid: String(task['assignedCarerUid'] || '').trim() || null,
    assignedCarerUsername: String(task['assignedCarerUsername'] || task['assignedCarer'] || '').trim() || null,
    claimedByUid: String(task['claimedByUid'] || '').trim() || null,
    automationJobId: String(task['automationJobId'] || '').trim() || null,
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
    : await requireApiUser(request, ['carer']);
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

  const userReadStartedAt = Date.now();
  const userSnap = await adminDb.collection('users').doc(carerUid).get();
  logAutoTickTiming('user_read', userReadStartedAt, {
    carerUid,
    exists: userSnap.exists,
  });
  if (!userSnap.exists) {
    return apiError('User not found.', 404);
  }
  const userData = userSnap.data() as {
    automationAgentId?: string | null;
    username?: string | null;
    role?: string | null;
    coadminUid?: string | null;
    createdBy?: string | null;
  };
  if (String(userData.role || '').toLowerCase() !== 'carer') {
    return apiError('Automation auto-tick is only available for carer accounts.', 403);
  }
  const coadminUid =
    String(userData.coadminUid || '').trim() || String(userData.createdBy || '').trim();
  if (!coadminUid) {
    console.info('[AUTO_TICK] skipped auto tick', {
      carerUid,
      reason: 'missing_profile_coadmin_uid',
    });
    return NextResponse.json({ ok: true, claimed: false, reason: 'missing_coadmin_uid' });
  }
  console.info('[AUTO_TICK] request received', {
    carerUid,
    carerUsername: String(userData.username || '').trim() || null,
    agentId,
    instanceId,
  });
  const linked = validateAutomationAgentId(String(userData.automationAgentId || '').trim());
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
  const stateReadStartedAt = Date.now();
  const stateSnap = await stateRef.get();
  logAutoTickTiming('state_read', stateReadStartedAt, {
    carerUid,
    exists: stateSnap.exists,
  });
  const state = stateSnap.exists ? (stateSnap.data() as { enabled?: boolean; coadminUid?: string }) : null;
  console.info('[AUTO_TICK] automation enabled state', {
    carerUid,
    carerUsername: String(userData.username || '').trim() || null,
    stateExists: stateSnap.exists,
    enabled: Boolean(state?.enabled),
    stateCoadminUidIgnored: String(state?.coadminUid || '').trim() || null,
    coadminUid,
  });
  if (!state?.enabled) {
    console.info('[AUTO_TICK] skipped auto tick', {
      carerUid,
      reason: 'automation_disabled',
    });
    return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
  }
  const leaseStartedAt = Date.now();
  const isBrowserAutoTick = !hasValidSecret && instanceId.startsWith('carer-ui-');
  if (isBrowserAutoTick) {
    logAutoTickTiming('lease_transaction', leaseStartedAt, {
      carerUid,
      coadminUid,
      instanceId,
      acquired: true,
      skipped: true,
      mode: 'browser_claim_transaction_guard',
    });
  } else {
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
      logAutoTickTiming('lease_transaction', leaseStartedAt, {
        carerUid,
        coadminUid,
        instanceId,
        acquired: true,
        mode: 'transaction',
      });
    } catch (e) {
      logAutoTickTiming('lease_transaction', leaseStartedAt, {
        carerUid,
        coadminUid,
        instanceId,
        acquired: false,
        error: e instanceof Error ? e.message : String(e),
      });
      const msg = e instanceof Error ? e.message : String(e);
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
      throw e;
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
    carerUsername: String(userData.username || '').trim() || null,
    coadminUid,
    maxClaimsPerTick: MAX_CLAIMS_PER_TICK,
    pendingQueryLimit: PENDING_QUERY_LIMIT,
    inProgressPoolCount: null,
    myInProgressCount: null,
    myInProgressTaskIds: [],
    inProgressSnapshotSkipped: true,
  });

  const pendingStartedAt = Date.now();
  const pendingSnap = await adminDb
    .collection('carerTasks')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(PENDING_QUERY_LIMIT)
    .get();
  logAutoTickTiming('pending_query', pendingStartedAt, {
    carerUid,
    coadminUid,
    resultCount: pendingSnap.docs.length,
  });

  console.info('[AUTO_TICK] pending query result', {
    carerUid,
    coadminUid,
    candidateCount: pendingSnap.docs.length,
    candidateTaskIds: pendingSnap.docs.map((d) => d.id),
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

  for (const docSnap of pendingSnap.docs) {
    if (claimedJobs.length >= MAX_CLAIMS_PER_TICK) {
      console.info('[AUTO_TICK] claim batch limit reached', {
        carerUid,
        coadminUid,
        claimedCount: claimedJobs.length,
        maxClaimsPerTick: MAX_CLAIMS_PER_TICK,
      });
      break;
    }

    const task: Record<string, unknown> & { id: string } = {
      id: docSnap.id,
      ...(docSnap.data() as Record<string, unknown>),
    };
    console.info('[AUTO_TICK] pending task from query', {
      taskId: docSnap.id,
      fields: taskDebugFields(task),
    });
    const mapped = mapTaskType(resolveTaskTypeLabel(task));
    if (!isAgentSupportedAutomationType(mapped)) {
      console.info('[AUTO_TICK] skipped task (unsupported type)', {
        taskId: docSnap.id,
        reason: 'unsupported_automation_type',
        mapped,
      });
      skippedTasks.push({
        taskId: docSnap.id,
        reason: 'unsupported_automation_type',
        mapped,
      });
      continue;
    }
    const gameName = String(task['gameName'] || task['game'] || '').trim();
    const playerUid = String(task['playerUid'] || '').trim();
    if (!gameName || !playerUid) {
      console.info('[AUTO_TICK] skipped task (missing game or player)', {
        taskId: docSnap.id,
        reason: 'missing_game_or_player',
      });
      skippedTasks.push({
        taskId: docSnap.id,
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
    logAutoTickTiming('resolve_game_login_details', gameLoginStartedAt, {
      taskId: docSnap.id,
      coadminUid,
      gameName,
      found: Boolean(gameLoginDetails),
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
    logAutoTickTiming('resolve_current_username', usernameStartedAt, {
      taskId: docSnap.id,
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

    const carerName = String(userData.username || '').trim() || 'Carer';

    console.info('[AUTO_TICK] attempting claim for pending task', {
      taskId: docSnap.id,
      selectedTaskId: docSnap.id,
      gameName,
      playerUid,
      beforeFields: taskDebugFields(task),
    });

    const claimStartedAt = Date.now();
    try {
      const result = await claimCarerTaskAsAdmin({
        carerUid,
        carerCoadminUid: coadminUid,
        taskId: docSnap.id,
        currentUsername,
        carerName,
        gameLoginDetails,
        trustedUser: {
          username: String(userData.username || '').trim() || null,
          automationAgentId: linked.normalized,
        },
      });
      logAutoTickTiming('claimCarerTaskAsAdmin_total', claimStartedAt, {
        taskId: docSnap.id,
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
        taskId: docSnap.id,
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
        const latestTaskSnap = await adminDb.collection('carerTasks').doc(docSnap.id).get();
        const latestTask = latestTaskSnap.exists ? (latestTaskSnap.data() as Record<string, unknown>) : null;
        console.info('[AUTO_TICK] skipped task after claim attempt', {
          taskId: docSnap.id,
          reason: 'claim_rejected',
          message,
          latestFields: latestTask ? taskDebugFields(latestTask) : null,
        });
        skippedTasks.push({
          taskId: docSnap.id,
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
        return NextResponse.json({ ok: false, claimed: false, reason: 'quota', error: message }, { status: 429 });
      }
      console.error('[AUTO_TICK] unexpected claim error', { taskId: docSnap.id, message });
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
    candidateCount: pendingSnap.docs.length,
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
