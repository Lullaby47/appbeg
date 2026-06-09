import { Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { startPlayerCashoutTaskInSql } from '@/lib/sql/authorityCashout';
import { mirrorPlayerCashoutTaskById } from '@/lib/sql/playerCashoutTasksCache';

type Body = {
  taskId?: unknown;
};

const TASK_DURATION_MS = 3 * 60 * 1000;

function logRejected(reason: string, context: Record<string, unknown>) {
  console.warn('[CASHOUT_START_API] rejected reason=' + reason, context);
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const taskId = String(body.taskId || '').trim();
    if (!taskId) {
      return apiError('taskId is required.', 400);
    }

    const caller = auth.user;
    const callerIsAdmin = caller.role === 'admin';
    const callerScope = scopedCoadminUid(caller);

    console.info('[CASHOUT_START_API] start requested', {
      taskId,
      callerUid: caller.uid,
      role: caller.role,
    });

    if (isAuthoritySqlWriteEnabled()) {
      const result = await startPlayerCashoutTaskInSql({
        taskId,
        actorUid: caller.uid,
        actorUsername: caller.username,
        actorRole: caller.role,
        isAdmin: callerIsAdmin,
        scopeUid: callerScope,
      });
      logAuthoritySqlWrite('/api/cashout-tasks/start', {
        taskId,
        duplicate: result.duplicate,
        expiresAtMs: result.expiresAtMs,
      });
      return NextResponse.json({
        authority: 'sql',
        ...result,
      });
    }

    const taskRef = adminDb.collection('playerCashoutTasks').doc(taskId);

    const result = await adminDb.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);
      if (!taskSnap.exists) {
        logRejected('not_found', { taskId, callerUid: caller.uid });
        throw new Error('Cashout task not found.');
      }

      const task = taskSnap.data() as {
        status?: string;
        coadminUid?: string;
        assignedHandlerUid?: string | null;
        expiresAt?: Timestamp | null;
      };
      const status = String(task.status || '').toLowerCase();
      const taskScope = String(task.coadminUid || '').trim();

      if (!callerIsAdmin && (!callerScope || callerScope !== taskScope)) {
        logRejected('outside_scope', {
          taskId,
          callerUid: caller.uid,
          callerScope,
          taskScope,
        });
        throw new Error('Forbidden: cashout task is outside your scope.');
      }

      if (status === 'completed') {
        logRejected('completed', { taskId, callerUid: caller.uid });
        throw new Error('Task already completed.');
      }
      if (status === 'declined') {
        logRejected('declined', { taskId, callerUid: caller.uid });
        throw new Error('Task already declined.');
      }
      if (status !== 'pending' && status !== 'in_progress') {
        logRejected('invalid_status', { taskId, callerUid: caller.uid, status });
        throw new Error('Cashout task is not available to start.');
      }

      const expiresAtMs = task.expiresAt?.toMillis?.() || 0;
      const activeInProgress =
        status === 'in_progress' && (!expiresAtMs || expiresAtMs > Date.now());
      if (
        activeInProgress &&
        task.assignedHandlerUid &&
        task.assignedHandlerUid !== caller.uid
      ) {
        logRejected('assigned_to_another_handler', {
          taskId,
          callerUid: caller.uid,
          assignedHandlerUid: task.assignedHandlerUid,
        });
        throw new Error('This task is already assigned to another handler.');
      }

      const now = Timestamp.now();
      const expiresAt = Timestamp.fromMillis(now.toMillis() + TASK_DURATION_MS);
      transaction.update(taskRef, {
        status: 'in_progress',
        assignedHandlerUid: caller.uid,
        assignedHandlerUsername: caller.username || 'Handler',
        startedAt: now,
        expiresAt,
      });

      return { expiresAtMs: expiresAt.toMillis() };
    });

    console.info('[CASHOUT_START_API] task started', {
      taskId,
      callerUid: caller.uid,
      expiresAtMs: result.expiresAtMs,
    });
    void mirrorPlayerCashoutTaskById(taskId, 'appbeg_cashout_start');

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start cashout task.';
    const status =
      /not authenticated|authorization|token/i.test(message)
        ? 401
        : /forbidden|outside your scope|already assigned/i.test(message)
          ? 403
          : /already|not available|conflict/i.test(message)
            ? 409
            : /required|not found|invalid/i.test(message)
              ? 400
              : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
