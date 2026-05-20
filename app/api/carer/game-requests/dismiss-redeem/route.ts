import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';

type Body = {
  requestId?: unknown;
};

type ScopedRecord = {
  coadminUid?: string | null;
  createdBy?: string | null;
};

const DISMISSIBLE_REDEEM_STATUSES = new Set(['pending', 'poked', 'pending_review']);

function ttlAfterDays(days: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return new Date(Date.now() + days * DAY_MS);
}

function recordScope(record: ScopedRecord) {
  return String(record.coadminUid || '').trim() || String(record.createdBy || '').trim();
}

function errorStatus(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope/i.test(message)) return 403;
  if (/not dismissible|already|conflict/i.test(message)) return 409;
  if (/required|not found|only|missing scope/i.test(message)) return 400;
  return 500;
}

export async function POST(request: Request) {
  const requestIdForLog = { requestId: '' };

  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const requestId = String(body.requestId || '').trim();
    requestIdForLog.requestId = requestId;
    console.info('DISMISS_REDEEM start', {
      requestId,
      callerUid: auth.user.uid,
      callerRole: auth.user.role,
    });

    if (!requestId) {
      return apiError('requestId is required.', 400);
    }

    const caller = auth.user;
    const callerScope = scopedCoadminUid(caller);
    const isAdmin = caller.role === 'admin';
    const requestRef = adminDb.collection('playerGameRequests').doc(requestId);
    const taskRef = adminDb.collection('carerTasks').doc(`request__${requestId}`);

    const outcome = await adminDb.runTransaction(async (transaction) => {
      const [requestSnap, taskSnap] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(taskRef),
      ]);

      if (!requestSnap.exists) {
        throw new Error('Request not found.');
      }

      const requestData = requestSnap.data() as ScopedRecord & {
        type?: string;
        status?: string;
        playerUid?: string;
      };
      if (String(requestData.type || '').toLowerCase() !== 'redeem') {
        throw new Error('Only redeem requests can be dismissed.');
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

      const playerData = playerSnap.data() as ScopedRecord & { role?: string };
      if (String(playerData.role || '').toLowerCase() !== 'player') {
        throw new Error('Request player not found.');
      }

      const requestScope = recordScope(requestData);
      const playerScope = recordScope(playerData);
      const canonicalRequestScope = requestScope || playerScope;
      if (!canonicalRequestScope) {
        throw new Error('Request missing scope.');
      }
      if (requestScope && playerScope && requestScope !== playerScope) {
        throw new Error('Forbidden: request is outside your scope.');
      }
      if (!isAdmin && (!callerScope || callerScope !== canonicalRequestScope)) {
        throw new Error('Forbidden: request is outside your scope.');
      }

      if (taskSnap.exists) {
        const taskData = taskSnap.data() as ScopedRecord & { requestId?: string };
        const taskScope = recordScope(taskData);
        if (
          String(taskData.requestId || requestId).trim() !== requestId ||
          (taskScope && taskScope !== canonicalRequestScope)
        ) {
          throw new Error('Forbidden: linked task is outside your scope.');
        }
      }

      const currentStatus = String(requestData.status || '').toLowerCase();
      if (currentStatus === 'dismissed') {
        return { alreadyDismissed: true, taskDeleted: false };
      }
      if (!DISMISSIBLE_REDEEM_STATUSES.has(currentStatus)) {
        throw new Error('Redeem request is not dismissible.');
      }

      transaction.update(requestRef, {
        status: 'dismissed',
        completedAt: FieldValue.serverTimestamp(),
        ttlExpiresAt: ttlAfterDays(90),
        pokedAt: null,
        pokeMessage: null,
        fakeRedeem: null,
        fakeRedeemReason: null,
        dismissType: 'carer_manual',
        dismissedByAutomation: null,
        dismissReasonCode: null,
        dismissReasonMessage: null,
        dismissMeta: null,
        automationError: null,
        error: null,
        failureReason: null,
        retryPending: null,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (taskSnap.exists) {
        transaction.delete(taskRef);
      }

      return { alreadyDismissed: false, taskDeleted: taskSnap.exists };
    });

    console.info('DISMISS_REDEEM success', {
      requestId,
      callerUid: auth.user.uid,
      callerRole: auth.user.role,
      ...outcome,
    });
    return NextResponse.json({ success: true, ...outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to dismiss redeem request.';
    const status = errorStatus(message);
    if (status === 403) {
      console.warn('DISMISS_REDEEM forbidden', {
        requestId: requestIdForLog.requestId,
        error: message,
      });
    }
    return NextResponse.json({ error: message }, { status });
  }
}
