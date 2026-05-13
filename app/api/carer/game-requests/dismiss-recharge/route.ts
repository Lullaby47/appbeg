import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';

type Body = {
  requestId?: unknown;
};

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const requestId = String(body.requestId || '').trim();
    if (!requestId) {
      return apiError('requestId is required.', 400);
    }

    const caller = auth.user;
    const callerScope = scopedCoadminUid(caller);
    const isAdmin = caller.role === 'admin';
    const requestRef = adminDb.collection('playerGameRequests').doc(requestId);
    const taskRef = adminDb.collection('carerTasks').doc(`request__${requestId}`);
    const eventRef = adminDb.collection('financialEvents').doc();

    const outcome = await adminDb.runTransaction(async (transaction) => {
      const [requestSnap, taskSnap] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(taskRef),
      ]);
      if (!requestSnap.exists) {
        throw new Error('Request not found.');
      }

      const requestData = requestSnap.data() as {
        type?: string;
        status?: string;
        playerUid?: string;
        amount?: number;
        baseAmount?: number | null;
        coinDeductedOnRequest?: boolean | null;
        coinRefundedOnDismissal?: boolean | null;
        coadminUid?: string | null;
        createdBy?: string | null;
      };
      if (String(requestData.type || '').toLowerCase() !== 'recharge') {
        throw new Error('Only recharge requests can be dismissed.');
      }

      const requestCoadminUid =
        String(requestData.coadminUid || '').trim() || String(requestData.createdBy || '').trim();
      if (!isAdmin && (!callerScope || callerScope !== requestCoadminUid)) {
        throw new Error('Forbidden: request is outside your scope.');
      }

      const currentStatus = String(requestData.status || '').toLowerCase();
      if (currentStatus === 'dismissed') {
        return { alreadyDismissed: true, refunded: false };
      }
      if (currentStatus !== 'pending') {
        throw new Error('Request is not pending.');
      }

      const playerUid = String(requestData.playerUid || '').trim();
      if (!playerUid) {
        throw new Error('Request player not found.');
      }
      const playerRef = adminDb.collection('users').doc(playerUid);
      const playerSnap = await transaction.get(playerRef);
      if (!playerSnap.exists) {
        throw new Error('Player not found.');
      }
      const playerData = playerSnap.data() as { coin?: number };
      const currentCoin = Math.max(0, Number(playerData.coin || 0));

      const deductedAmount = Math.max(
        0,
        Number((requestData.baseAmount ?? requestData.amount ?? 0) || 0)
      );
      const shouldRefund =
        Boolean(requestData.coinDeductedOnRequest) &&
        !Boolean(requestData.coinRefundedOnDismissal) &&
        deductedAmount > 0;

      transaction.update(requestRef, {
        status: 'dismissed',
        completedAt: FieldValue.serverTimestamp(),
        ttlExpiresAt: ttlAfterDays(90),
        pokedAt: null,
        pokeMessage: null,
        dismissType: 'carer_manual',
        ...(shouldRefund
          ? {
              coinRefundedOnDismissal: true,
              coinRefundedOnDismissalAt: FieldValue.serverTimestamp(),
            }
          : {}),
      });
      if (taskSnap.exists) {
        transaction.delete(taskRef);
      }

      if (shouldRefund) {
        transaction.update(playerRef, {
          coin: currentCoin + deductedAmount,
        });
        transaction.set(eventRef, {
          playerUid,
          coadminUid: requestCoadminUid,
          amountNpr: deductedAmount,
          type: 'recharge_refund',
          requestId,
          createdAt: FieldValue.serverTimestamp(),
          ttlExpiresAt: ttlAfterDays(90),
        });
      }

      return { alreadyDismissed: false, refunded: shouldRefund };
    });

    return NextResponse.json({ success: true, ...outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to dismiss recharge request.';
    const status =
      /not authenticated|authorization|token/i.test(message)
        ? 401
        : /forbidden|outside your scope/i.test(message)
          ? 403
          : /not pending|already|conflict/i.test(message)
            ? 409
            : /required|not found|only/i.test(message)
              ? 400
              : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

