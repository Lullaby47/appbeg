import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { mapTaskType, resolveTaskTypeLabel } from '@/lib/automation/automationClaimPayload';
import {
  claimCarerTaskAsAdmin,
  resolveCurrentUsernameForTask,
  resolveGameLoginDetailsForCoadminGame,
} from '@/lib/automation/carerClaimTaskAdmin';
import { AUTOMATION_AUTO_STATE_COLLECTION } from '@/features/automation/automationAutoState';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';

const LEASE_TTL_MS = 70_000;

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
  console.info('[AUTO_TICK] route called', {
    hasSecretHeader: Boolean(String(request.headers.get('x-carer-automation-tick-secret') || '').trim()),
    hasAuthorization: Boolean(String(request.headers.get('Authorization') || '').trim()),
  });

  const expected = String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim();
  const provided = String(request.headers.get('x-carer-automation-tick-secret') || '').trim();
  const hasValidSecret = Boolean(expected && provided && provided === expected);
  const auth = hasValidSecret
    ? null
    : await requireApiUser(request, ['carer', 'staff', 'coadmin', 'admin']);
  if (auth && 'response' in auth) {
    return auth.response;
  }

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
  if (auth && 'user' in auth && auth.user.role === 'carer' && auth.user.uid !== carerUid) {
    return apiError('Forbidden: cannot tick automation for another carer.', 403);
  }

  const userSnap = await adminDb.collection('users').doc(carerUid).get();
  if (!userSnap.exists) {
    return apiError('User not found.', 404);
  }
  const userData = userSnap.data() as { automationAgentId?: string | null; username?: string | null };
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
  const stateSnap = await stateRef.get();
  const state = stateSnap.exists ? (stateSnap.data() as { enabled?: boolean; coadminUid?: string }) : null;
  console.info('[AUTO_TICK] automation enabled state', {
    carerUid,
    carerUsername: String(userData.username || '').trim() || null,
    stateExists: stateSnap.exists,
    enabled: Boolean(state?.enabled),
    coadminUid: String(state?.coadminUid || '').trim() || null,
  });
  if (!state?.enabled) {
    console.info('[AUTO_TICK] skipped auto tick', {
      carerUid,
      reason: 'automation_disabled',
    });
    return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
  }
  const coadminUid = String(state.coadminUid || '').trim();
  if (!coadminUid) {
    console.info('[AUTO_TICK] skipped auto tick', {
      carerUid,
      reason: 'missing_coadmin_uid',
    });
    return NextResponse.json({ ok: true, claimed: false, reason: 'missing_coadmin_uid' });
  }

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
  } catch (e) {
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

  const inProgressSnap = await adminDb
    .collection('carerTasks')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'in_progress')
    .limit(40)
    .get();

  const myInProgress = inProgressSnap.docs.filter((d) => {
    const row = d.data() as { assignedCarerUid?: string; claimedByUid?: string };
    const a = String(row.assignedCarerUid || '').trim();
    const c = String(row.claimedByUid || '').trim();
    return a === carerUid || c === carerUid;
  });

  console.info('[AUTO_TICK] pending candidates and in-progress gate', {
    carerUid,
    carerUsername: String(userData.username || '').trim() || null,
    coadminUid,
    pendingQueryLimit: 15,
    inProgressPoolCount: inProgressSnap.docs.length,
    myInProgressCount: myInProgress.length,
    myInProgressTaskIds: myInProgress.map((d) => d.id),
  });

  if (myInProgress.length > 0) {
    console.info('[AUTO_TICK] active in_progress exists for this carer, waiting', {
      carerUid,
      taskIds: myInProgress.map((d) => d.id),
    });
    return NextResponse.json({
      ok: true,
      claimed: false,
      reason: 'already_in_progress',
      myInProgressTaskIds: myInProgress.map((d) => d.id),
    });
  }

  const pendingSnap = await adminDb
    .collection('carerTasks')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(15)
    .get();

  console.info('[AUTO_TICK] pending query result', {
    carerUid,
    coadminUid,
    candidateCount: pendingSnap.docs.length,
    candidateTaskIds: pendingSnap.docs.map((d) => d.id),
  });

  for (const docSnap of pendingSnap.docs) {
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
      continue;
    }
    const gameName = String(task['gameName'] || task['game'] || '').trim();
    const playerUid = String(task['playerUid'] || '').trim();
    if (!gameName || !playerUid) {
      console.info('[AUTO_TICK] skipped task (missing game or player)', {
        taskId: docSnap.id,
        reason: 'missing_game_or_player',
      });
      continue;
    }

    const gameLoginDetails = await resolveGameLoginDetailsForCoadminGame(coadminUid, gameName);
    const fromLogin = await resolveCurrentUsernameForTask(coadminUid, playerUid, gameName);
    const currentUsername =
      fromLogin ||
      (String(
        (typeof task['currentUsername'] === 'string' ? task['currentUsername'] : '') ||
          (typeof task['gameAccountUsername'] === 'string' ? task['gameAccountUsername'] : '') ||
          ''
      ).trim() ||
        null);

    const userRow = userSnap.data() as { username?: string };
    const carerName = String(userRow.username || '').trim() || 'Carer';

    console.info('[AUTO_TICK] attempting claim for pending task', {
      taskId: docSnap.id,
      selectedTaskId: docSnap.id,
      gameName,
      playerUid,
      beforeFields: taskDebugFields(task),
    });

    try {
      const result = await claimCarerTaskAsAdmin({
        carerUid,
        taskId: docSnap.id,
        currentUsername,
        carerName,
        gameLoginDetails,
      });
      const afterTaskSnap = await adminDb.collection('carerTasks').doc(result.taskId).get();
      const afterTask = afterTaskSnap.exists ? (afterTaskSnap.data() as Record<string, unknown>) : null;
      console.info('[AUTO_TICK] claimed pending task as in_progress', {
        taskId: result.taskId,
        jobId: result.jobId,
        carerUid,
        reusedExistingJob: result.reusedExistingJob,
        automationJobCreated: !result.reusedExistingJob,
        originalTaskUpdatedToInProgress:
          Boolean(afterTask) &&
          String(afterTask?.['status'] || '').trim().toLowerCase() === 'in_progress' &&
          String(afterTask?.['assignedCarerUid'] || '').trim() === carerUid,
        afterFields: afterTask ? taskDebugFields(afterTask) : null,
      });
      return NextResponse.json({
        ok: true,
        claimed: true,
        taskId: result.taskId,
        jobId: result.jobId,
        reusedExistingJob: result.reusedExistingJob,
      });
    } catch (err) {
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

  console.info('[AUTO_TICK] no claimable pending task after scanning candidates', {
    candidateCount: pendingSnap.docs.length,
  });
  return NextResponse.json({ ok: true, claimed: false, reason: 'no_claimable_task' });
}
