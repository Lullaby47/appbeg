import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';

type Body = { requestId?: unknown };

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const requestId = String(body.requestId || '').trim();
    if (!requestId) return apiError('requestId is required.', 400);

    const caller = auth.user;
    const callerScope = scopedCoadminUid(caller);
    const transferRef = adminDb.collection('transferRequests').doc(requestId);

    await adminDb.runTransaction(async (transaction) => {
      const transferSnap = await transaction.get(transferRef);
      if (!transferSnap.exists) throw new Error('Transfer request not found.');

      const transfer = transferSnap.data() as {
        status?: string;
        playerUid?: string;
        coadminUid?: string;
        amountNpr?: number;
      };
      if (String(transfer.status || '').toLowerCase() !== 'pending') {
        throw new Error('Transfer request already processed.');
      }
      const coadminUid = String(transfer.coadminUid || '').trim();
      if (caller.role !== 'admin' && coadminUid !== callerScope) {
        throw new Error('Forbidden: transfer request is outside your scope.');
      }

      const playerRef = adminDb.collection('users').doc(String(transfer.playerUid || '').trim());
      const playerSnap = await transaction.get(playerRef);
      if (!playerSnap.exists) throw new Error('Player profile not found.');
      const playerData = playerSnap.data() as { coin?: number; cash?: number };
      const cashNow = Number(playerData.cash || 0);
      const amountNpr = Math.max(0, Number(transfer.amountNpr || 0));
      if (cashNow < amountNpr || amountNpr <= 0) {
        throw new Error('Transfer request is no longer valid due to low cash balance.');
      }

      transaction.update(playerRef, {
        coin: Number(playerData.coin || 0) + amountNpr,
        cash: cashNow - amountNpr,
      });
      transaction.update(transferRef, {
        status: 'approved',
        approvedByUid: caller.uid,
        approvedByUsername: caller.username,
        approvedAt: FieldValue.serverTimestamp(),
        rejectionReason: null,
        processedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(adminDb.collection('financialEvents').doc(), {
        playerUid: String(transfer.playerUid || '').trim(),
        coadminUid,
        amountNpr,
        type: 'transfer',
        transferRequestId: requestId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to approve transfer request.';
    const status = /forbidden|scope/i.test(message) ? 403 : /not authenticated|authorization|token/i.test(message) ? 401 : /not found|required|only|valid|low cash/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

