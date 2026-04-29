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
  addDoc,
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
  status: 'pending' | 'completed';
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

  await addDoc(collection(db, 'carerCashouts'), {
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

export async function completeCarerCashoutRequest(cashoutId: string) {
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

  const pendingForCarerQuery = query(
    collection(db, 'carerCashouts'),
    where('carerUid', '==', cashout.carerUid),
    where('status', '==', 'pending')
  );
  const pendingSnapshot = await getDocs(pendingForCarerQuery);
  const batch = writeBatch(db);

  pendingSnapshot.docs.forEach((docSnap) => {
    batch.update(docSnap.ref, {
      status: 'completed',
      completedAt: serverTimestamp(),
    });
  });

  batch.set(
    doc(db, 'users', cashout.carerUid),
    {
      cashBoxNpr: 0,
    },
    { merge: true }
  );

  await batch.commit();
}
