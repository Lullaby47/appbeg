import {
  Timestamp,
  getDocs,
  limit,
  writeBatch,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { attachPendingCarerCashoutsSqlPoll } from '@/features/live/coadminCarerCashoutsSqlRead';
import { clientOnSnapshot } from '@/lib/client/clientFirestoreQuery';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

const CARER_CASHOUT_PENDING_LISTENER_LIMIT = 100;
const CARER_CASHOUT_HISTORY_LISTENER_LIMIT = 50;

async function getAuthHeaders() {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }
  const token = await currentUser.getIdToken();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function readApiError(messageFallback: string, payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof (payload as { error?: unknown }).error === 'string'
  ) {
    return String((payload as { error: string }).error || messageFallback);
  }
  return messageFallback;
}

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

  const response = await fetch('/api/carer/cashouts', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      action: 'create',
      amountNpr,
      paymentQrUrl: values.paymentQrUrl,
      paymentQrPublicId: values.paymentQrPublicId,
      paymentDetails: values.paymentDetails,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to create claim pay request.', payload));
  }
}

export function listenPendingCashoutsByCoadmin(
  coadminUid: string,
  onChange: (items: CarerCashoutRequest[]) => void,
  onError?: (error: Error) => void
) {
  if (isClientSqlReadMode()) {
    return attachPendingCarerCashoutsSqlPoll({
      coadminUid,
      limit: CARER_CASHOUT_PENDING_LISTENER_LIMIT,
      onChange,
      onError,
    });
  }

  const cashoutQuery = query(
    collection(db, 'carerCashouts'),
    where('coadminUid', '==', coadminUid),
    where('status', '==', 'pending'),
    orderBy('createdAt', 'desc'),
    limit(CARER_CASHOUT_PENDING_LISTENER_LIMIT)
  );

  return clientOnSnapshot(
    cashoutQuery,
    {
      file: 'features/cashouts/carerCashouts.ts',
      hook: 'listenPendingCashoutsByCoadmin',
      collection: 'carerCashouts',
      where: { coadminUid, status: 'pending' },
      orderBy: { field: 'createdAt', direction: 'desc' },
    },
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
    where('carerUid', '==', carerUid),
    orderBy('createdAt', 'desc'),
    limit(CARER_CASHOUT_HISTORY_LISTENER_LIMIT)
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
  const response = await fetch('/api/carer/cashouts', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      action: 'complete',
      cashoutId,
      amountNpr: doneAmountNpr,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to complete claim pay request.', payload));
  }
}

export async function declineCarerCashoutRequest(cashoutId: string) {
  const response = await fetch('/api/carer/cashouts', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      action: 'decline',
      cashoutId,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to decline claim pay request.', payload));
  }
}
