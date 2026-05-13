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
import { apiError } from '@/lib/firebase/apiAuth';

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

export async function POST(request: Request) {
  const expected = String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim();
  if (!expected) {
    return apiError('Server is not configured for automation auto-tick.', 503);
  }

  const provided = String(request.headers.get('x-carer-automation-tick-secret') || '').trim();
  if (!provided || provided !== expected) {
    return apiError('Unauthorized.', 401);
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

  const userSnap = await adminDb.collection('users').doc(carerUid).get();
  if (!userSnap.exists) {
    return apiError('User not found.', 404);
  }
  const userData = userSnap.data() as { automationAgentId?: string | null };
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
  if (!state?.enabled) {
    return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
  }
  const coadminUid = String(state.coadminUid || '').trim();
  if (!coadminUid) {
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
      return NextResponse.json({ ok: true, claimed: false, reason: 'lease_held' });
    }
    if (msg === 'DISABLED' || msg === 'STATE_GONE') {
      return NextResponse.json({ ok: true, claimed: false, reason: 'disabled' });
    }
    throw e;
  }

  const pendingSnap = await adminDb
    .collection('carerTasks')
    .where('coadminUid', '==', coadminUid)
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(15)
    .get();

  for (const docSnap of pendingSnap.docs) {
    const task: Record<string, unknown> & { id: string } = {
      id: docSnap.id,
      ...(docSnap.data() as Record<string, unknown>),
    };
    const mapped = mapTaskType(resolveTaskTypeLabel(task));
    if (!isAgentSupportedAutomationType(mapped)) {
      continue;
    }
    const gameName = String(task['gameName'] || task['game'] || '').trim();
    const playerUid = String(task['playerUid'] || '').trim();
    if (!gameName || !playerUid) {
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

    try {
      const result = await claimCarerTaskAsAdmin({
        carerUid,
        taskId: docSnap.id,
        currentUsername,
        carerName,
        gameLoginDetails,
      });
      console.info('[automation] auto tick claimed task', {
        taskId: result.taskId,
        jobId: result.jobId,
        carerUid,
        reusedExistingJob: result.reusedExistingJob,
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
      return NextResponse.json({ ok: false, claimed: false, error: message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, claimed: false, reason: 'no_claimable_task' });
}
