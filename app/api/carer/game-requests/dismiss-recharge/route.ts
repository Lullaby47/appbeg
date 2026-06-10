import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { dismissRechargeRequestInSql } from '@/lib/sql/authorityGameRequests';
import { tombstoneCarerTaskCache } from '@/lib/sql/carerTasksCache';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorPlayerGameRequestById } from '@/lib/sql/playerGameRequestsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

type Body = {
  requestId?: unknown;
  taskId?: unknown;
  taskStatus?: unknown;
  amount?: unknown;
  playerUid?: unknown;
  idempotencyKey?: unknown;
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
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    console.info('[DISMISS_RECHARGE_REQUEST_BODY]', {
      requestId,
      taskId: String(body.taskId || '').trim() || `request__${requestId}`,
      taskStatus: String(body.taskStatus || '').trim() || null,
      gameRequestStatus: null,
      amount: Number.isFinite(Number(body.amount)) ? Number(body.amount) : null,
      playerUid: String(body.playerUid || '').trim() || null,
      carerUid: caller.uid,
      coadminUid: callerScope,
    });

    if (isAuthoritySqlWriteEnabled()) {
      const outcome = await dismissRechargeRequestInSql({
        requestId,
        actorUid: caller.uid,
        actorRole: caller.role,
        isAdmin,
        scopeUid: callerScope,
        idempotencyKey,
      });
      logAuthoritySqlWrite('/api/carer/game-requests/dismiss-recharge', {
        requestId,
        duplicate: outcome.duplicate,
        refunded: outcome.refunded,
      });
      return NextResponse.json({
        ok: true,
        success: true,
        alreadyDismissed: outcome.alreadyDismissed,
        refunded: outcome.refunded,
        playerUid: '',
        taskDeleted: outcome.taskDeleted,
        linkedTaskId: outcome.linkedTaskId,
        retryMarkersCleared: true,
        duplicate: outcome.duplicate,
        authority: 'sql',
      });
    }

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
      const alreadyDismissed = currentStatus === 'dismissed';
      console.info('[REQUEST_DISMISS] requestId=%s statusBefore=%s', requestId, currentStatus || null);
      console.info('[REQUEST_DISMISS] alreadyDismissed=%s', alreadyDismissed);
      console.info('[REQUEST_DISMISS] linkedTaskId=%s', taskRef.id);
      if (!alreadyDismissed && currentStatus !== 'pending') {
        throw new Error('Request is not pending.');
      }

      if (alreadyDismissed) {
        transaction.update(requestRef, {
          retryPending: null,
          retryableFailure: null,
          resetToPendingAt: null,
          returnedToPendingAt: null,
          pendingSince: null,
          automationJobId: null,
          automationStatus: null,
          automationError: null,
        });
        if (taskSnap.exists) {
          transaction.delete(taskRef);
        }
        return {
          alreadyDismissed: true,
          refunded: false,
          playerUid: '',
          taskDeleted: taskSnap.exists,
          linkedTaskId: taskRef.id,
          retryMarkersCleared: true,
        };
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
        !alreadyDismissed &&
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
        retryPending: null,
        retryableFailure: null,
        resetToPendingAt: null,
        returnedToPendingAt: null,
        pendingSince: null,
        automationJobId: null,
        automationStatus: null,
        automationError: null,
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

      return {
        alreadyDismissed,
        refunded: shouldRefund,
        playerUid,
        taskDeleted: taskSnap.exists,
        linkedTaskId: taskRef.id,
        retryMarkersCleared: true,
      };
    });

    console.info('[REQUEST_DISMISS] requestId=%s alreadyDismissed=%s', requestId, outcome.alreadyDismissed);
    console.info('[REQUEST_DISMISS] linkedTaskId=%s', outcome.linkedTaskId);
    console.info('[REQUEST_DISMISS] linkedTaskDeleted=%s', outcome.taskDeleted);
    console.info('[REQUEST_DISMISS] retryMarkersCleared=%s', outcome.retryMarkersCleared);
    if (outcome.taskDeleted) {
      void tombstoneCarerTaskCache(outcome.linkedTaskId, 'appbeg_dismiss_recharge');
    }
    void mirrorPlayerGameRequestById(requestId, 'appbeg_dismiss_recharge');
    if (outcome.refunded) {
      void mirrorFinancialEventById(eventRef.id, 'appbeg_dismiss_recharge');
      void mirrorUserBalanceSnapshotById(outcome.playerUid, 'appbeg_dismiss_recharge');
    }
    return NextResponse.json({ success: true, ...outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to dismiss recharge request.';
    const normalized = message.toLowerCase();
    if (
      normalized.includes('not pending') ||
      normalized.includes('already dismissed') ||
      normalized.includes('already handled') ||
      normalized.includes('request not found')
    ) {
      console.info('[DISMISS_RECHARGE_SQL_STATE]', {
        requestId: null,
        beforeStatus: 'unknown',
        afterStatus: 'dismissed',
        alreadyDismissed: true,
        alreadyRefunded: false,
        duplicateOperation: true,
        refundApplied: false,
        taskUpdated: false,
        outboxInserted: false,
        ok: true,
        reason: message,
      });
      return NextResponse.json({
        ok: true,
        success: true,
        duplicate: true,
        alreadyDismissed: true,
        refunded: false,
        alreadyHandled: true,
      });
    }
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
    console.warn('[DISMISS_RECHARGE_SQL_STATE]', {
      requestId: null,
      beforeStatus: 'unknown',
      afterStatus: 'unknown',
      alreadyDismissed: false,
      alreadyRefunded: false,
      duplicateOperation: false,
      refundApplied: false,
      taskUpdated: false,
      outboxInserted: false,
      ok: false,
      reason: message,
    });
    return NextResponse.json({ error: message }, { status });
  }
}

