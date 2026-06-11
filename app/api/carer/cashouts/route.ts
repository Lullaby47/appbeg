import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import {
  completeCarerCashoutInSql,
  createCarerCashoutInSql,
  declineCarerCashoutInSql,
} from '@/lib/sql/authorityCarerCashouts';
import { mirrorCarerCashoutById } from '@/lib/sql/carerCashoutsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

type Body = {
  action?: unknown;
  cashoutId?: unknown;
  amountNpr?: unknown;
  paymentQrUrl?: unknown;
  paymentQrPublicId?: unknown;
  paymentDetails?: unknown;
};

function canSettleCarerCashout(role: string) {
  return role === 'admin' || role === 'coadmin';
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['carer', 'staff', 'coadmin', 'admin']);
    if ('response' in auth) return auth.response;
    const body = (await request.json()) as Body;
    const action = String(body.action || '').trim();
    const authoritySql = isAuthoritySqlWriteEnabled();
    const callerScope = scopedCoadminUid(auth.user);

    if (action === 'create') {
      const amountNpr = Math.max(0, Math.round(Number(body.amountNpr || 0)));
      if (amountNpr <= 0) return apiError('Cash box amount must be greater than zero.', 400);

      if (authoritySql) {
        if (!callerScope) return apiError('No coadmin scope found.', 400);
        const result = await createCarerCashoutInSql({
          workerUid: auth.user.uid,
          workerRole: auth.user.role,
          workerUsername: auth.user.username || 'Carer',
          coadminUid: callerScope,
          amountNpr,
          paymentQrUrl: String(body.paymentQrUrl || '').trim() || null,
          paymentQrPublicId: String(body.paymentQrPublicId || '').trim() || null,
          paymentDetails: String(body.paymentDetails || '').trim() || null,
          actorUid: auth.user.uid,
        });
        logAuthoritySqlWrite('/api/carer/cashouts', { action: 'create', ...result });
        return NextResponse.json({ authority: 'sql', success: true, cashoutId: result.cashoutId });
      }

      const userRef = adminDb.collection('users').doc(auth.user.uid);
      const cashoutRef = adminDb.collection('carerCashouts').doc();
      await adminDb.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) throw new Error('Current user profile not found.');
        const user = userSnap.data() as { cashBoxNpr?: number; username?: string; role?: string };
        const role = String(user.role || '').toLowerCase();
        if (role !== 'carer' && role !== 'staff') {
          throw new Error('Only staff/carer can create claim pay requests.');
        }
        if (!callerScope) throw new Error('No coadmin scope found.');
        const cashBoxBefore = Number(user.cashBoxNpr || 0);
        const cashBoxAfter = 0;
        transaction.set(cashoutRef, {
          coadminUid: callerScope,
          carerUid: auth.user.uid,
          carerUsername: String(user.username || '').trim() || 'Carer',
          amountNpr,
          paymentQrUrl: String(body.paymentQrUrl || '').trim() || null,
          paymentQrPublicId: String(body.paymentQrPublicId || '').trim() || null,
          paymentDetails: String(body.paymentDetails || '').trim() || null,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
          completedAt: null,
          payoutAmountNpr: amountNpr,
          cashBoxBefore,
          cashBoxAfter,
          cashBoxDelta: cashBoxAfter - cashBoxBefore,
          actorUid: auth.user.uid,
          actorRole: auth.user.role,
          sourceCashoutId: cashoutRef.id,
          rewardReason: 'claim_pay_create',
        });
        transaction.set(userRef, { cashBoxNpr: cashBoxAfter }, { merge: true });
      });
      void mirrorCarerCashoutById(cashoutRef.id, 'appbeg_carer_cashout_create');
      void mirrorUserBalanceSnapshotById(auth.user.uid, 'appbeg_carer_cashout_create');
      return NextResponse.json({ success: true, cashoutId: cashoutRef.id });
    }

    const cashoutId = String(body.cashoutId || '').trim();
    if (!cashoutId) return apiError('cashoutId is required.', 400);

    if (action === 'complete') {
      if (!canSettleCarerCashout(auth.user.role)) {
        return apiError('Forbidden: only admin or coadmin can complete cashout requests.', 403);
      }

      if (authoritySql) {
        const result = await completeCarerCashoutInSql({
          cashoutId,
          doneAmountNpr: Math.max(0, Math.round(Number(body.amountNpr || 0))),
          actorUid: auth.user.uid,
          actorRole: auth.user.role,
          callerCoadminUid: callerScope,
          isAdmin: auth.user.role === 'admin',
        });
        logAuthoritySqlWrite('/api/carer/cashouts', { action: 'complete', cashoutId, ...result });
        return NextResponse.json({ authority: 'sql', success: true });
      }

      const cashoutRef = adminDb.collection('carerCashouts').doc(cashoutId);
      let mirroredCarerUid = '';
      const mirroredCashoutIds = new Set<string>();
      await adminDb.runTransaction(async (transaction) => {
        const cashoutSnap = await transaction.get(cashoutRef);
        if (!cashoutSnap.exists) throw new Error('Cashout request not found.');
        const cashout = cashoutSnap.data() as {
          status?: string;
          coadminUid?: string;
          carerUid?: string;
          amountNpr?: number;
        };
        if (String(cashout.status || '').toLowerCase() !== 'pending') {
          throw new Error('Cashout request is already completed.');
        }
        if (auth.user.role !== 'admin' && String(cashout.coadminUid || '').trim() !== callerScope) {
          throw new Error('Forbidden: cashout request is outside your scope.');
        }
        const requestedAmount = Math.max(0, Math.round(Number(cashout.amountNpr || 0)));
        const doneAmountNpr = Math.max(0, Math.round(Number(body.amountNpr || 0)));
        const resolved = doneAmountNpr > 0 ? doneAmountNpr : requestedAmount;
        if (resolved > requestedAmount) {
          throw new Error('Done amount cannot be greater than claim amount.');
        }
        const remainingAmountNpr = Math.max(0, requestedAmount - resolved);
        const userRef = adminDb.collection('users').doc(String(cashout.carerUid || '').trim());
        const userSnap = await transaction.get(userRef);
        const cashBoxBefore = userSnap.exists
          ? Math.max(0, Number((userSnap.data() as { cashBoxNpr?: number }).cashBoxNpr || 0))
          : 0;
        const cashBoxAfter = remainingAmountNpr;

        const pendingSnap = await adminDb
          .collection('carerCashouts')
          .where('carerUid', '==', String(cashout.carerUid || '').trim())
          .where('status', '==', 'pending')
          .get();

        pendingSnap.docs.forEach((docSnap) => {
          mirroredCashoutIds.add(docSnap.id);
          if (docSnap.id === cashoutId) {
            transaction.update(docSnap.ref, {
              status: 'completed',
              completedAt: FieldValue.serverTimestamp(),
              completedAmountNpr: resolved,
              remainingAmountNpr,
              payoutAmountNpr: resolved,
              cashBoxBefore,
              cashBoxAfter,
              cashBoxDelta: cashBoxAfter - cashBoxBefore,
              actorUid: auth.user.uid,
              actorRole: auth.user.role,
              sourceCashoutId: cashoutId,
              rewardReason: 'claim_pay_complete',
            });
          } else {
            transaction.update(docSnap.ref, {
              status: 'completed',
              completedAt: FieldValue.serverTimestamp(),
            });
          }
        });
        transaction.set(userRef, { cashBoxNpr: cashBoxAfter }, { merge: true });
        mirroredCarerUid = String(cashout.carerUid || '').trim();
      });
      mirroredCashoutIds.forEach((id) => {
        void mirrorCarerCashoutById(id, 'appbeg_carer_cashout_complete');
      });
      void mirrorUserBalanceSnapshotById(mirroredCarerUid, 'appbeg_carer_cashout_complete');
      return NextResponse.json({ success: true });
    }

    if (action === 'decline') {
      if (!canSettleCarerCashout(auth.user.role)) {
        return apiError('Forbidden: only admin or coadmin can decline cashout requests.', 403);
      }

      if (authoritySql) {
        const result = await declineCarerCashoutInSql({
          cashoutId,
          actorUid: auth.user.uid,
          actorRole: auth.user.role,
          callerCoadminUid: callerScope,
          isAdmin: auth.user.role === 'admin',
        });
        logAuthoritySqlWrite('/api/carer/cashouts', { action: 'decline', cashoutId, ...result });
        return NextResponse.json({ authority: 'sql', success: true });
      }

      const cashoutRef = adminDb.collection('carerCashouts').doc(cashoutId);
      let mirroredCarerUid = '';
      await adminDb.runTransaction(async (transaction) => {
        const cashoutSnap = await transaction.get(cashoutRef);
        if (!cashoutSnap.exists) throw new Error('Cashout request not found.');
        const cashout = cashoutSnap.data() as {
          status?: string;
          coadminUid?: string;
          carerUid?: string;
          amountNpr?: number;
        };
        if (String(cashout.status || '').toLowerCase() !== 'pending') {
          throw new Error('Only pending cashout requests can be declined.');
        }
        if (auth.user.role !== 'admin' && String(cashout.coadminUid || '').trim() !== callerScope) {
          throw new Error('Forbidden: cashout request is outside your scope.');
        }
        const amountNpr = Math.max(0, Math.round(Number(cashout.amountNpr || 0)));
        const userRef = adminDb.collection('users').doc(String(cashout.carerUid || '').trim());
        const userSnap = await transaction.get(userRef);
        const currentCashBox = userSnap.exists
          ? Math.max(0, Number((userSnap.data() as { cashBoxNpr?: number }).cashBoxNpr || 0))
          : 0;
        const cashBoxAfter = currentCashBox + amountNpr;
        transaction.update(cashoutRef, {
          status: 'declined',
          completedAt: FieldValue.serverTimestamp(),
          completedAmountNpr: 0,
          remainingAmountNpr: amountNpr,
          payoutAmountNpr: 0,
          cashBoxBefore: currentCashBox,
          cashBoxAfter,
          cashBoxDelta: cashBoxAfter - currentCashBox,
          actorUid: auth.user.uid,
          actorRole: auth.user.role,
          sourceCashoutId: cashoutId,
          rewardReason: 'claim_pay_decline',
        });
        transaction.set(userRef, { cashBoxNpr: cashBoxAfter }, { merge: true });
        mirroredCarerUid = String(cashout.carerUid || '').trim();
      });
      void mirrorCarerCashoutById(cashoutId, 'appbeg_carer_cashout_decline');
      void mirrorUserBalanceSnapshotById(mirroredCarerUid, 'appbeg_carer_cashout_decline');
      return NextResponse.json({ success: true });
    }

    return apiError('Unsupported action.', 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to process carer cashout.';
    const status = /not authenticated|authorization|token/i.test(message) ? 401 : /forbidden|scope/i.test(message) ? 403 : /required|not found|only|unsupported|greater than/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
