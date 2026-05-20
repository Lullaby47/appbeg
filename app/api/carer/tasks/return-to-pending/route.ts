import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';

type Body = {
  taskId?: unknown;
};

type ScopedRecord = {
  coadminUid?: string | null;
  createdBy?: string | null;
};

type TaskRecord = ScopedRecord & {
  status?: string | null;
  requestId?: string | null;
  automationJobId?: string | null;
  linkedJobId?: string | null;
  currentJobId?: string | null;
  activeJobId?: string | null;
};

type JobState = {
  ref: FirebaseFirestore.DocumentReference;
  exists: boolean;
  status: string;
  taskId: string;
  scope: string;
};

const ACTIVE_JOB_STATUSES = new Set([
  'queued',
  'waiting',
  'running',
  'in_progress',
  'cancelled_requested',
]);

const RESETTABLE_TASK_STATUSES = new Set(['pending', 'in_progress', 'failed', 'urgent']);
const RESETTABLE_REQUEST_STATUSES = new Set(['pending', 'poked', 'pending_review', 'failed']);

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

function automationJobDocId(carerUid: string, taskId: string) {
  const uid = String(carerUid || '').trim();
  const tid = String(taskId || '').trim().replace(/\//g, '_');
  if (!uid || !tid) {
    throw new Error('carerUid and taskId are required for automation job id.');
  }
  return `${uid}--${tid}`;
}

function recordScope(record: ScopedRecord) {
  return String(record.coadminUid || '').trim() || String(record.createdBy || '').trim();
}

function buildTaskPendingResetFields() {
  return {
    status: 'pending',
    assignedCarerUid: null,
    assignedCarer: null,
    assignedCarerUsername: null,
    claimedStatus: null,
    claimedAt: null,
    claimedByUid: null,
    claimedByUsername: null,
    startedAt: null,
    runningAt: null,
    expiresAt: null,
    completedAt: null,
    cancelledAt: null,
    failedAt: null,
    ttlExpiresAt: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
    lastHeartbeatAt: null,
    automationStatus: null,
    automationJobId: null,
    linkedJobId: null,
    currentJobId: null,
    activeJobId: null,
    assignedJobStatus: null,
    automationError: null,
    error: null,
    failureReason: null,
    lastFailureReason: null,
    retryPending: true,
    resetToPendingAt: FieldValue.serverTimestamp(),
    returnedToPendingAt: FieldValue.serverTimestamp(),
    pendingSince: FieldValue.serverTimestamp(),
    automationUpdatedAt: FieldValue.serverTimestamp(),
    queuedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function buildLinkedRequestPendingResetFields() {
  return {
    status: 'pending',
    automationStatus: null,
    automationJobId: null,
    linkedJobId: null,
    completedAt: null,
    dismissedAt: null,
    failedAt: null,
    ttlExpiresAt: null,
    pokedAt: null,
    pokeMessage: null,
    fakeRedeem: null,
    fakeRedeemReason: null,
    dismissType: null,
    dismissedByAutomation: null,
    dismissReasonCode: null,
    dismissReasonMessage: null,
    dismissMeta: null,
    automationError: null,
    resetToPendingAt: FieldValue.serverTimestamp(),
    returnedToPendingAt: FieldValue.serverTimestamp(),
    error: null,
    failureReason: null,
    lastFailureReason: null,
    retryPending: true,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function errorStatus(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope/i.test(message)) return 403;
  if (/not resettable|settled|finalized|completed|dismissed|conflict/i.test(message)) return 409;
  if (/required|not found|missing scope/i.test(message)) return 400;
  return 500;
}

export async function POST(request: Request) {
  const logContext = { taskId: '' };

  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const taskId = String(body.taskId || '').trim();
    logContext.taskId = taskId;
    console.info('RETURN_TO_PENDING start', {
      taskId,
      callerUid: auth.user.uid,
      callerRole: auth.user.role,
    });

    if (!taskId) {
      return apiError('taskId is required.', 400);
    }

    const caller = auth.user;
    const callerScope = scopedCoadminUid(caller);
    const isAdmin = caller.role === 'admin';
    const taskRef = adminDb.collection('carerTasks').doc(taskId);

    const outcome = await adminDb.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);
      if (!taskSnap.exists) {
        throw new Error('Task not found.');
      }

      const task = taskSnap.data() as TaskRecord;
      const taskScope = recordScope(task);
      if (!taskScope) {
        throw new Error('Task missing scope.');
      }
      if (!isAdmin && (!callerScope || callerScope !== taskScope)) {
        throw new Error('Forbidden: task is outside your scope.');
      }

      const oldTaskStatus = String(task.status || '').trim().toLowerCase();
      if (!RESETTABLE_TASK_STATUSES.has(oldTaskStatus)) {
        throw new Error('Task is not resettable.');
      }

      const linkedJobIds = [
        automationJobDocId(caller.uid, taskId),
        task.automationJobId,
        task.linkedJobId,
        task.currentJobId,
        task.activeJobId,
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      const jobRefsById = new Map(
        linkedJobIds.map((jobId) => [jobId, adminDb.collection('automation_jobs').doc(jobId)])
      );
      const sameTaskJobsSnap = await transaction.get(
        adminDb.collection('automation_jobs').where('taskId', '==', taskId).limit(20)
      );
      sameTaskJobsSnap.docs.forEach((jobSnap) => {
        jobRefsById.set(jobSnap.id, jobSnap.ref);
      });

      const jobStates: JobState[] = [];
      for (const jobRef of jobRefsById.values()) {
        const jobSnap = await transaction.get(jobRef);
        const jobData = jobSnap.exists ? (jobSnap.data() as ScopedRecord & { taskId?: string; status?: string }) : null;
        jobStates.push({
          ref: jobRef,
          exists: jobSnap.exists,
          status: String(jobData?.status || '').trim().toLowerCase(),
          taskId: String(jobData?.taskId || '').trim(),
          scope: jobData ? recordScope(jobData) : '',
        });
      }

      const requestId = String(task.requestId || '').trim();
      const requestRef = requestId ? adminDb.collection('playerGameRequests').doc(requestId) : null;
      const requestSnap = requestRef ? await transaction.get(requestRef) : null;
      const requestData = requestSnap?.exists
        ? (requestSnap.data() as ScopedRecord & { status?: string | null })
        : null;

      if (requestRef && requestSnap?.exists && requestData) {
        const requestScope = recordScope(requestData);
        if (requestScope && requestScope !== taskScope) {
          throw new Error('Forbidden: linked request is outside your scope.');
        }

        const requestStatus = String(requestData.status || '').trim().toLowerCase();
        if (requestStatus && !RESETTABLE_REQUEST_STATUSES.has(requestStatus)) {
          throw new Error('Linked request is settled and cannot be reset.');
        }
      }

      let cancelledJobs = 0;
      for (const job of jobStates) {
        if (!job.exists) {
          continue;
        }
        if (job.taskId && job.taskId !== taskId) {
          continue;
        }
        if (job.scope && job.scope !== taskScope) {
          throw new Error('Forbidden: linked automation job is outside your scope.');
        }
        if (!ACTIVE_JOB_STATUSES.has(job.status)) {
          continue;
        }

        transaction.update(job.ref, {
          status: 'cancelled',
          claimedStatus: 'cancelled',
          cancelledAt: FieldValue.serverTimestamp(),
          cancelledReason: 'returned_to_pending',
          updatedAt: FieldValue.serverTimestamp(),
          lastHeartbeatAt: FieldValue.serverTimestamp(),
          completedAt: FieldValue.serverTimestamp(),
          ttlExpiresAt: ttlAfterDays(14),
          error: 'Cancelled by carer (returned_to_pending).',
        });
        cancelledJobs += 1;
      }

      transaction.update(taskRef, buildTaskPendingResetFields());

      if (requestRef && requestSnap?.exists) {
        transaction.update(requestRef, buildLinkedRequestPendingResetFields());
      }

      return {
        oldTaskStatus,
        cancelledJobs,
        linkedRequestReset: Boolean(requestRef && requestSnap?.exists),
      };
    });

    console.info('RETURN_TO_PENDING success', {
      taskId,
      callerUid: auth.user.uid,
      callerRole: auth.user.role,
      ...outcome,
    });
    return NextResponse.json({ success: true, ...outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to move task back to pending.';
    const status = errorStatus(message);
    if (status === 403) {
      console.warn('RETURN_TO_PENDING forbidden', {
        taskId: logContext.taskId,
        error: message,
      });
    }
    return NextResponse.json({ error: message }, { status });
  }
}
