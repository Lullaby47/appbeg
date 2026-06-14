import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { releasePlayerCashoutTaskInSql } from '@/lib/sql/authorityCashout';
import { mirrorPlayerCashoutTaskById } from '@/lib/sql/playerCashoutTasksCache';

export const runtime = 'nodejs';

type Body = {
  taskId?: unknown;
};

function releaseStatusForError(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope|only the handler/i.test(message)) return 403;
  if (/already|not available|not pending|claimed|in_progress|conflict/i.test(message)) return 409;
  if (/required|not found|invalid/i.test(message)) return 400;
  return 500;
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

    if (isAuthoritySqlWriteEnabled()) {
      const result = await releasePlayerCashoutTaskInSql({
        taskId,
        actorUid: caller.uid,
        actorRole: caller.role,
        isAdmin: callerIsAdmin,
        scopeUid: callerScope,
        reason: 'manual',
      });
      logAuthoritySqlWrite('/api/cashout-tasks/release', {
        taskId,
        duplicate: result.duplicate,
        released: result.released,
      });
      return NextResponse.json({
        authority: 'sql',
        ...result,
      });
    }

    const taskRef = adminDb.collection('playerCashoutTasks').doc(taskId);
    await adminDb.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);
      if (!taskSnap.exists) {
        throw new Error('Cashout task not found.');
      }

      const task = taskSnap.data() as {
        status?: string;
        coadminUid?: string;
        assignedHandlerUid?: string | null;
      };
      const status = String(task.status || '').toLowerCase();
      const taskScope = String(task.coadminUid || '').trim();

      if (!callerIsAdmin && (!callerScope || callerScope !== taskScope)) {
        throw new Error('Forbidden: cashout task is outside your scope.');
      }
      if (status !== 'in_progress') {
        return;
      }
      if (
        task.assignedHandlerUid &&
        task.assignedHandlerUid !== caller.uid &&
        !callerIsAdmin &&
        caller.role !== 'coadmin'
      ) {
        throw new Error('Only the handler who claimed this task can release it.');
      }

      transaction.update(taskRef, {
        status: 'pending',
        assignedHandlerUid: null,
        assignedHandlerUsername: null,
        assignedHandlerRole: null,
        claimedByRole: null,
        claimedAt: null,
        startedAt: null,
        expiresAt: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    console.info('[CASHOUT_TASK_RELEASE] success', {
      taskId,
      actorUid: caller.uid,
      actorRole: caller.role,
      coadminUid: callerScope || null,
    });
    void mirrorPlayerCashoutTaskById(taskId, 'appbeg_cashout_release');

    return NextResponse.json({ success: true, released: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to release cashout task.';
    return NextResponse.json({ error: message }, { status: releaseStatusForError(message) });
  }
}
