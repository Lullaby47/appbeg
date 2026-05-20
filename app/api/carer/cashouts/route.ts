import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';

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

    if (action === 'create') {
      const amountNpr = Math.max(0, Math.round(Number(body.amountNpr || 0)));
      if (amountNpr <= 0) return apiError('Cash box amount must be greater than zero.', 400);
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
        const coadminUid = scopedCoadminUid(auth.user);
        if (!coadminUid) throw new Error('No coadmin scope found.');
        transaction.set(cashoutRef, {
          coadminUid,
          carerUid: auth.user.uid,
          carerUsername: String(user.username || '').trim() || 'Carer',
          amountNpr,
          paymentQrUrl: String(body.paymentQrUrl || '').trim() || null,
          paymentQrPublicId: String(body.paymentQrPublicId || '').trim() || null,
          paymentDetails: String(body.paymentDetails || '').trim() || null,
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
          completedAt: null,
        });
        transaction.set(userRef, { cashBoxNpr: 0 }, { merge: true });
      });
      return NextResponse.json({ success: true, cashoutId: cashoutRef.id });
    }

    const cashoutId = String(body.cashoutId || '').trim();
    if (!cashoutId) return apiError('cashoutId is required.', 400);
    const cashoutRef = adminDb.collection('carerCashouts').doc(cashoutId);

    if (action === 'complete') {
      if (!canSettleCarerCashout(auth.user.role)) {
        return apiError('Forbidden: only admin or coadmin can complete cashout requests.', 403);
      }
      const doneAmountNpr = Math.max(0, Math.round(Number(body.amountNpr || 0)));
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
        if (
          auth.user.role !== 'admin' &&
          String(cashout.coadminUid || '').trim() !== scopedCoadminUid(auth.user)
        ) {
          throw new Error('Forbidden: cashout request is outside your scope.');
        }
        const requestedAmount = Math.max(0, Math.round(Number(cashout.amountNpr || 0)));
        const resolved = doneAmountNpr > 0 ? doneAmountNpr : requestedAmount;
        if (resolved > requestedAmount) {
          throw new Error('Done amount cannot be greater than claim amount.');
        }
        const remainingAmountNpr = Math.max(0, requestedAmount - resolved);

        const pendingSnap = await adminDb
          .collection('carerCashouts')
          .where('carerUid', '==', String(cashout.carerUid || '').trim())
          .where('status', '==', 'pending')
          .get();

        pendingSnap.docs.forEach((docSnap) => {
          if (docSnap.id === cashoutId) {
            transaction.update(docSnap.ref, {
              status: 'completed',
              completedAt: FieldValue.serverTimestamp(),
              completedAmountNpr: resolved,
              remainingAmountNpr,
            });
          } else {
            transaction.update(docSnap.ref, {
              status: 'completed',
              completedAt: FieldValue.serverTimestamp(),
            });
          }
        });
        transaction.set(
          adminDb.collection('users').doc(String(cashout.carerUid || '').trim()),
          { cashBoxNpr: remainingAmountNpr },
          { merge: true }
        );
      });
      return NextResponse.json({ success: true });
    }

    if (action === 'decline') {
      if (!canSettleCarerCashout(auth.user.role)) {
        return apiError('Forbidden: only admin or coadmin can decline cashout requests.', 403);
      }
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
        if (
          auth.user.role !== 'admin' &&
          String(cashout.coadminUid || '').trim() !== scopedCoadminUid(auth.user)
        ) {
          throw new Error('Forbidden: cashout request is outside your scope.');
        }
        const amountNpr = Math.max(0, Math.round(Number(cashout.amountNpr || 0)));
        const userRef = adminDb.collection('users').doc(String(cashout.carerUid || '').trim());
        const userSnap = await transaction.get(userRef);
        const currentCashBox = userSnap.exists
          ? Math.max(0, Number((userSnap.data() as { cashBoxNpr?: number }).cashBoxNpr || 0))
          : 0;
        transaction.update(cashoutRef, {
          status: 'declined',
          completedAt: FieldValue.serverTimestamp(),
          completedAmountNpr: 0,
          remainingAmountNpr: amountNpr,
        });
        transaction.set(userRef, { cashBoxNpr: currentCashBox + amountNpr }, { merge: true });
      });
      return NextResponse.json({ success: true });
    }

    return apiError('Unsupported action.', 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to process carer cashout.';
    const status = /not authenticated|authorization|token/i.test(message) ? 401 : /forbidden|scope/i.test(message) ? 403 : /required|not found|only|unsupported|greater than claim/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

