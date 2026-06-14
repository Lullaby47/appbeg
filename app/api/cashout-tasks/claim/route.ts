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

export const runtime = 'nodejs';

type Body = {
  taskId?: unknown;
};

const TASK_DURATION_MS = 3 * 60 * 1000;

function claimStatusForError(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope/i.test(message)) return 403;
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

    console.info('[CASHOUT_TASK_CLAIM] attempting', {
      taskId,
      callerUid: caller.uid,
      role: caller.role,
      coadminUid: callerScope || null,
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
      logAuthoritySqlWrite('/api/cashout-tasks/claim', {
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
        console.warn('[CASHOUT_TASK_CLAIM] forbiddenScope', {
          taskId,
          callerUid: caller.uid,
          callerRole: caller.role,
          callerScope: callerScope || null,
          taskScope,
        });
        throw new Error('Forbidden: cashout task is outside your scope.');
      }

      if (status !== 'pending' || task.assignedHandlerUid) {
        console.warn('[CASHOUT_TASK_CLAIM] conflictAlreadyClaimed', {
          taskId,
          callerUid: caller.uid,
          callerRole: caller.role,
          status,
          assignedHandlerUid: task.assignedHandlerUid || null,
        });
        throw new Error('already_claimed_or_not_pending');
      }

      const now = Timestamp.now();
      const expiresAt = Timestamp.fromMillis(now.toMillis() + TASK_DURATION_MS);
      transaction.update(taskRef, {
        status: 'in_progress',
        assignedHandlerUid: caller.uid,
        assignedHandlerUsername: caller.username || 'Handler',
        assignedHandlerRole: caller.role,
        claimedByRole: caller.role,
        claimedAt: now,
        startedAt: now,
        expiresAt,
      });

      return { expiresAtMs: expiresAt.toMillis(), taskScope };
    });

    console.info('[CASHOUT_TASK_CLAIM] success', {
      taskId,
      callerUid: caller.uid,
      role: caller.role,
      coadminUid: result.taskScope,
      expiresAtMs: result.expiresAtMs,
    });
    void mirrorPlayerCashoutTaskById(taskId, 'appbeg_cashout_claim');

    return NextResponse.json({ success: true, expiresAtMs: result.expiresAtMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to claim cashout task.';
    return NextResponse.json({ error: message }, { status: claimStatusForError(message) });
  }
}
