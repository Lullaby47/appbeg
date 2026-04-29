import {
  Timestamp,
  getDocs,
  writeBatch,
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';

export type CarerCashoutRequest = {
  id: string;
  coadminUid: string;
  carerUid: string;
  carerUsername: string;
  amountNpr: number;
  paymentQrUrl?: string | null;
  paymentQrPublicId?: string | null;
  paymentDetails?: string | null;
  status: 'pending' | 'completed' | 'declined';
  completedAmountNpr?: number | null;
  remainingAmountNpr?: number | null;
  createdAt?: Timestamp | null;
  completedAt?: Timestamp | null;
};

export async function saveCarerPaymentDetails(values: {
  paymentQrUrl: string;
  paymentQrPublicId?: string;
  paymentDetails: string;
}) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  await updateDoc(doc(db, 'users', currentUser.uid), {
    paymentQrUrl: values.paymentQrUrl.trim(),
    paymentQrPublicId: values.paymentQrPublicId?.trim() || null,
    paymentDetails: values.paymentDetails.trim(),
  });
}

export async function createCarerCashoutRequest(values: {
  coadminUid: string;
  carerUid: string;
  carerUsername: string;
  amountNpr: number;
  paymentQrUrl?: string;
  paymentQrPublicId?: string;
  paymentDetails?: string;
}) {
  const amountNpr = Math.round(Number(values.amountNpr || 0));

  if (amountNpr <= 0) {
    throw new Error('Cash box amount must be greater than zero.');
  }

  const currentUser = auth.currentUser;
  const actorUid = currentUser?.uid || String(values.carerUid || '').trim();

  if (!actorUid) {
    throw new Error('Not authenticated.');
  }

  if (actorUid !== values.carerUid) {
    throw new Error('Only the current carer can create a cashout request.');
  }

  const cashoutRef = doc(collection(db, 'carerCashouts'));
  const userRef = doc(db, 'users', values.carerUid);

  await runTransaction(db, async (transaction) => {
    transaction.set(cashoutRef, {
      coadminUid: values.coadminUid,
      carerUid: values.carerUid,
      carerUsername: values.carerUsername || 'Carer',
      amountNpr,
      paymentQrUrl: values.paymentQrUrl?.trim() || null,
      paymentQrPublicId: values.paymentQrPublicId?.trim() || null,
      paymentDetails: values.paymentDetails?.trim() || null,
      status: 'pending',
      createdAt: serverTimestamp(),
      completedAt: null,
    });

    // Claim Pay should immediately clear the sender's cash box.
    transaction.set(
      userRef,
      {
        cashBoxNpr: 0,
      },
      { merge: true }
    );
  });
}

export function listenPendingCashoutsByCoadmin(
  coadminUid: string,
  onChange: (items: CarerCashoutRequest[]) => void,
  onError?: (error: Error) => void
) {
  const cashoutQuery = query(
    collection(db, 'carerCashouts'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'pending')
  );

  return onSnapshot(
    cashoutQuery,
    (snapshot) => {
      const items = snapshot.docs
        .map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<CarerCashoutRequest, 'id'>),
        }))
        .sort((a, b) => {
          const aTime = a.createdAt?.toMillis?.() || 0;
          const bTime = b.createdAt?.toMillis?.() || 0;
          return bTime - aTime;
        });
      onChange(items);
    },
    (error) => onError?.(error as Error)
  );
}

/** Claim Pay history for staff/carers (staff use `carerUid` matching their UID). */
export function listenCarerCashoutsByCarerUid(
  carerUid: string,
  onChange: (items: CarerCashoutRequest[]) => void,
  onError?: (error: Error) => void
) {
  const cashoutsQuery = query(
    collection(db, 'carerCashouts'),
    where('carerUid', '==', carerUid)
  );

  return onSnapshot(
    cashoutsQuery,
    (snapshot) => {
      const items = snapshot.docs
        .map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<CarerCashoutRequest, 'id'>),
        }))
        .sort((a, b) => {
          const aTime = Math.max(
            a.completedAt?.toMillis?.() || 0,
            a.createdAt?.toMillis?.() || 0
          );
          const bTime = Math.max(
            b.completedAt?.toMillis?.() || 0,
            b.createdAt?.toMillis?.() || 0
          );
          return bTime - aTime;
        });
      onChange(items);
    },
    (error) => onError?.(error as Error)
  );
}

export async function completeCarerCashoutRequest(cashoutId: string, doneAmountNpr?: number) {
  const cashoutRef = doc(db, 'carerCashouts', cashoutId);

  const cashout = await runTransaction(db, async (transaction) => {
    const cashoutSnap = await transaction.get(cashoutRef);

    if (!cashoutSnap.exists()) {
      throw new Error('Cashout request not found.');
    }

    const cashoutData = cashoutSnap.data() as Omit<CarerCashoutRequest, 'id'>;

    if (cashoutData.status !== 'pending') {
      throw new Error('Cashout request is already completed.');
    }

    return cashoutData;
  });

  const resolvedDoneAmount = Math.max(
    0,
    Math.round(Number((doneAmountNpr ?? cashout.amountNpr) || 0))
  );
  const requestedAmount = Math.max(0, Math.round(Number(cashout.amountNpr || 0)));

  if (resolvedDoneAmount > requestedAmount) {
    throw new Error('Done amount cannot be greater than claim amount.');
  }

  const remainingAmountNpr = Math.max(0, requestedAmount - resolvedDoneAmount);

  const pendingForCarerQuery = query(
    collection(db, 'carerCashouts'),
    where('carerUid', '==', cashout.carerUid),
    where('status', '==', 'pending')
  );
  const pendingSnapshot = await getDocs(pendingForCarerQuery);
  const batch = writeBatch(db);

  pendingSnapshot.docs.forEach((docSnap) => {
    if (docSnap.id === cashoutId) {
      batch.update(docSnap.ref, {
        status: 'completed',
        completedAt: serverTimestamp(),
        completedAmountNpr: resolvedDoneAmount,
        remainingAmountNpr,
      });
      return;
    }

    batch.update(docSnap.ref, {
      status: 'completed',
      completedAt: serverTimestamp(),
    });
  });

  batch.set(
    doc(db, 'users', cashout.carerUid),
    {
      cashBoxNpr: remainingAmountNpr,
    },
    { merge: true }
  );

  await batch.commit();
}

export async function declineCarerCashoutRequest(cashoutId: string) {
  const cashoutRef = doc(db, 'carerCashouts', cashoutId);

  await runTransaction(db, async (transaction) => {
    const cashoutSnap = await transaction.get(cashoutRef);

    if (!cashoutSnap.exists()) {
      throw new Error('Cashout request not found.');
    }

    const cashoutData = cashoutSnap.data() as Omit<CarerCashoutRequest, 'id'>;

    if (cashoutData.status !== 'pending') {
      throw new Error('Only pending cashout requests can be declined.');
    }

    const amountNpr = Math.max(0, Math.round(Number(cashoutData.amountNpr || 0)));
    const userRef = doc(db, 'users', cashoutData.carerUid);
    const userSnap = await transaction.get(userRef);
    const currentCashBox = userSnap.exists()
      ? Math.max(0, Number((userSnap.data() as { cashBoxNpr?: number }).cashBoxNpr || 0))
      : 0;

    transaction.update(cashoutRef, {
      status: 'declined',
      completedAt: serverTimestamp(),
      completedAmountNpr: 0,
      remainingAmountNpr: amountNpr,
    });
    transaction.set(
      userRef,
      {
        cashBoxNpr: currentCashBox + amountNpr,
      },
      { merge: true }
    );
  });
}
