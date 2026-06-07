import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { mirrorRewardCutById } from '@/lib/sql/rewardCutsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

type Body = {
  workerUid?: unknown;
  workerRole?: unknown;
  workerUsername?: unknown;
  amountNpr?: unknown;
  reason?: unknown;
};

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['coadmin']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const workerUid = String(body.workerUid || '').trim();
    const workerRole = String(body.workerRole || '').trim().toLowerCase();
    const workerUsername = String(body.workerUsername || '').trim() || 'Worker';
    const reason = String(body.reason || '').trim() || 'Manual adjustment';
    const cutAmount = Math.max(0, Math.round(Number(body.amountNpr || 0)));
    if (!workerUid) return apiError('workerUid is required.', 400);
    if (workerRole !== 'staff' && workerRole !== 'carer') return apiError('workerRole must be staff or carer.', 400);
    if (cutAmount <= 0) return apiError('Cut amount must be greater than 0.', 400);

    const targetRef = adminDb.collection('users').doc(workerUid);
    const rewardCutRef = adminDb.collection('rewardCuts').doc();
    let updatedCashBox = 0;

    await adminDb.runTransaction(async (transaction) => {
      const targetSnap = await transaction.get(targetRef);
      if (!targetSnap.exists) throw new Error('Worker account not found.');
      const target = targetSnap.data() as {
        role?: string;
        cashBoxNpr?: number;
        coadminUid?: string | null;
        createdBy?: string | null;
      };
      const targetScope =
        String(target.coadminUid || '').trim() || String(target.createdBy || '').trim();
      if (targetScope !== auth.user.uid) throw new Error('Worker is outside your coadmin scope.');
      if (String(target.role || '').toLowerCase() !== workerRole) throw new Error('Worker role mismatch.');

      const oldCash = Math.max(0, Number(target.cashBoxNpr || 0));
      updatedCashBox = Math.max(0, oldCash - cutAmount);
      transaction.update(targetRef, {
        cashBoxNpr: updatedCashBox,
        lastRewardCutAt: FieldValue.serverTimestamp(),
      });
      transaction.set(rewardCutRef, {
        coadminUid: auth.user.uid,
        workerUid,
        workerRole,
        workerUsername,
        amountNpr: cutAmount,
        reason,
        cashBoxBefore: oldCash,
        cashBoxAfter: updatedCashBox,
        cashBoxDelta: updatedCashBox - oldCash,
        actorUid: auth.user.uid,
        actorRole: 'coadmin',
        sourceRewardCutId: rewardCutRef.id,
        rewardReason: reason || 'Manual adjustment',
        createdAt: FieldValue.serverTimestamp(),
        createdByUid: auth.user.uid,
      });
    });

    void mirrorRewardCutById(rewardCutRef.id, 'appbeg_worker_reward_cut');
    void mirrorUserBalanceSnapshotById(workerUid, 'appbeg_worker_reward_cut');
    return NextResponse.json({ success: true, updatedCashBox });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to cut reward.';
    const status = /not authenticated|authorization|token/i.test(message) ? 401 : /outside your coadmin scope|forbidden/i.test(message) ? 403 : /required|not found|mismatch|greater than/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

