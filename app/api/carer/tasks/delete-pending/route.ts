import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';

type Body = {
  taskId?: unknown;
};

type ScopedTask = {
  coadminUid?: string | null;
  createdBy?: string | null;
  requestId?: string | null;
  status?: string | null;
  type?: string | null;
};

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

function recordScope(record: ScopedTask) {
  return String(record.coadminUid || '').trim() || String(record.createdBy || '').trim();
}

function isRequestTask(taskId: string, task: ScopedTask) {
  const taskType = String(task.type || '').toLowerCase();
  return (
    String(task.requestId || '').trim().length > 0 ||
    taskId.startsWith('request__') ||
    taskType === 'recharge' ||
    taskType === 'redeem'
  );
}

function errorStatus(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope/i.test(message)) return 403;
  if (/only pending|request tasks|not deletable|conflict/i.test(message)) return 409;
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
    console.info('DELETE_PENDING_TASK start', {
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

    await adminDb.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);

      if (!taskSnap.exists) {
        throw new Error('Task not found.');
      }

      const task = taskSnap.data() as ScopedTask;
      const taskScope = recordScope(task);
      if (!taskScope) {
        throw new Error('Task missing scope.');
      }
      if (!isAdmin && (!callerScope || callerScope !== taskScope)) {
        throw new Error('Forbidden: task is outside your scope.');
      }

      if (String(task.status || '').toLowerCase() !== 'pending') {
        throw new Error('Only pending tasks can be deleted.');
      }

      if (isRequestTask(taskId, task)) {
        throw new Error('Request tasks must be dismissed through their linked request.');
      }

      transaction.update(taskRef, {
        status: 'failed',
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
        completedAt: FieldValue.serverTimestamp(),
        ttlExpiresAt: ttlAfterDays(30),
        completedByCarerUid: null,
        completedByCarerUsername: null,
        automationStatus: null,
        automationJobId: null,
        linkedJobId: null,
        currentJobId: null,
        activeJobId: null,
        assignedJobStatus: null,
        automationError: null,
        error: null,
        failureReason: 'deleted_by_carer',
        deletedFromPendingAt: FieldValue.serverTimestamp(),
        deletedFromPendingByCarerUid: caller.uid,
        deletedFromPendingByCarerUsername: caller.username || 'Carer',
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    console.info('DELETE_PENDING_TASK success', {
      taskId,
      callerUid: auth.user.uid,
      callerRole: auth.user.role,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete pending task.';
    const status = errorStatus(message);
    if (status === 403) {
      console.warn('DELETE_PENDING_TASK forbidden', {
        taskId: logContext.taskId,
        error: message,
      });
    }
    return NextResponse.json({ error: message }, { status });
  }
}
