import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';

type Body = { taskId?: unknown };

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const taskId = String(body.taskId || '').trim();
    if (!taskId) return apiError('taskId is required.', 400);

    const caller = auth.user;
    const scope = scopedCoadminUid(caller);
    const taskRef = adminDb.collection('playerCashoutTasks').doc(taskId);

    await adminDb.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);
      if (!taskSnap.exists) throw new Error('Cashout task not found.');
      const task = taskSnap.data() as {
        status?: string;
        coadminUid?: string;
        playerUid?: string;
        amountNpr?: number;
        cashDeductedOnRequest?: boolean;
      };

      const status = String(task.status || '').toLowerCase();
      if (status !== 'pending' && status !== 'in_progress') {
        throw new Error('Only active cashout tasks can be declined.');
      }
      if (caller.role !== 'admin' && String(task.coadminUid || '').trim() !== scope) {
        throw new Error('Forbidden: cashout task is outside your scope.');
      }

      const amountNpr = Math.max(0, Math.round(Number(task.amountNpr || 0)));
      const playerRef = adminDb.collection('users').doc(String(task.playerUid || '').trim());
      const playerSnap = await transaction.get(playerRef);
      const playerCash = playerSnap.exists
        ? Math.max(0, Number((playerSnap.data() as { cash?: number }).cash || 0))
        : 0;

      transaction.update(taskRef, {
        status: 'declined',
        expiresAt: null,
        completedAt: FieldValue.serverTimestamp(),
      });
      if (task.cashDeductedOnRequest === true && amountNpr > 0) {
        transaction.set(
          playerRef,
          {
            cash: playerCash + amountNpr,
          },
          { merge: true }
        );
        transaction.set(adminDb.collection('financialEvents').doc(), {
          playerUid: String(task.playerUid || '').trim(),
          coadminUid: String(task.coadminUid || '').trim(),
          amountNpr,
          type: 'cashout_decline_refund',
          cashoutTaskId: taskId,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to decline cashout task.';
    const status = /forbidden|scope/i.test(message) ? 403 : /not authenticated|authorization|token/i.test(message) ? 401 : /not found|required|only/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

