import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  Timestamp,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import {
  belongsToCoadmin,
  getCurrentUserCoadminUid,
  type CoadminScopedRecord,
} from '@/lib/coadmin/scope';

export type PlayerGameRequestType = 'recharge' | 'redeem';
export type PlayerGameRequestStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'poked'
  | 'pending_review';

export type PlayerGameRequest = {
  id: string;
  playerUid: string;
  gameName: string;
  amount: number;
  baseAmount?: number | null;
  bonusPercentage?: number | null;
  bonusEventId?: string | null;
  type: PlayerGameRequestType;
  status: PlayerGameRequestStatus;
  createdBy?: string;
  coadminUid?: string;
  createdAt?: Timestamp | null;
  completedAt?: Timestamp | null;
  pokedAt?: Timestamp | null;
  pokeMessage?: string | null;
  /**
   * When true, the player's `coin` was already reduced when the request was
   * created; carer completion must not deduct again (legacy requests omit this).
   */
  coinDeductedOnRequest?: boolean | null;
};

function mapRequestDoc(docId: string, value: Omit<PlayerGameRequest, 'id'>) {
  return {
    id: docId,
    ...value,
  } satisfies PlayerGameRequest;
}

/** Dynamic import avoids a static circular dependency with `carerTasks`. */
async function upsertLinkedCarerTaskForRequest(request: PlayerGameRequest) {
  const { upsertCarerTaskForPlayerGameRequest } = await import('./carerTasks');
  await upsertCarerTaskForPlayerGameRequest(request);
}

function sortByNewest(requests: PlayerGameRequest[]) {
  return [...requests].sort((left, right) => {
    const leftTime =
      left.pokedAt?.toMillis?.() ||
      left.completedAt?.toMillis?.() ||
      left.createdAt?.toMillis?.() ||
      0;
    const rightTime =
      right.pokedAt?.toMillis?.() ||
      right.completedAt?.toMillis?.() ||
      right.createdAt?.toMillis?.() ||
      0;

    return rightTime - leftTime;
  });
}

async function getRequestsByStatuses(
  playerUid: string,
  statuses: PlayerGameRequestStatus[]
) {
  const results: PlayerGameRequest[] = [];

  for (const status of statuses) {
    const requestsQuery = query(
      collection(db, 'playerGameRequests'),
      where('playerUid', '==', playerUid),
      where('status', '==', status)
    );
    const snapshot = await getDocs(requestsQuery);

    snapshot.docs.forEach((docSnap) => {
      results.push(
        mapRequestDoc(
          docSnap.id,
          docSnap.data() as Omit<PlayerGameRequest, 'id'>
        )
      );
    });
  }

  return sortByNewest(results);
}

async function getRequestsByCoadminAndStatuses(
  coadminUid: string,
  statuses: PlayerGameRequestStatus[]
) {
  if (!coadminUid.trim() || statuses.length === 0) {
    return [];
  }

  const scopedQuery = query(
    collection(db, 'playerGameRequests'),
    where('coadminUid', '==', coadminUid),
    where('status', 'in', statuses)
  );
  const scopedSnapshot = await getDocs(scopedQuery);

  const requests = scopedSnapshot.docs.map((docSnap) =>
    mapRequestDoc(docSnap.id, docSnap.data() as Omit<PlayerGameRequest, 'id'>)
  );

  if (requests.length > 0) {
    return sortByNewest(requests);
  }

  const legacyQuery = query(
    collection(db, 'playerGameRequests'),
    where('createdBy', '==', coadminUid),
    where('status', 'in', statuses)
  );
  const legacySnapshot = await getDocs(legacyQuery);

  return sortByNewest(
    legacySnapshot.docs.map((docSnap) =>
      mapRequestDoc(docSnap.id, docSnap.data() as Omit<PlayerGameRequest, 'id'>)
    )
  );
}

async function assertCurrentPlayerIsActive(playerUid: string) {
  const playerSnap = await getDoc(doc(db, 'users', playerUid));

  if (!playerSnap.exists()) {
    throw new Error('Player profile not found.');
  }

  const playerData = playerSnap.data() as { status?: string };

  if (playerData.status === 'disabled') {
    throw new Error(
      'Your account is blocked. Recharge and redeem features are disabled.'
    );
  }
}

export async function createPlayerGameRequest(values: {
  gameName: string;
  amount: number;
  type: PlayerGameRequestType;
  baseAmount?: number;
  bonusPercentage?: number;
  bonusEventId?: string;
}) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  await assertCurrentPlayerIsActive(currentUser.uid);

  if (!values.gameName.trim()) {
    throw new Error('Game is required.');
  }

  if (!values.amount || values.amount <= 0) {
    throw new Error('Enter a valid amount.');
  }

  const requestAmount = Number(values.amount);
  if (!Number.isFinite(requestAmount) || requestAmount <= 0) {
    throw new Error('Enter a valid amount.');
  }

  const coadminUid = await getCurrentUserCoadminUid();

  if (values.type === 'recharge') {
    const playerRef = doc(db, 'users', currentUser.uid);
    const newRequestRef = doc(collection(db, 'playerGameRequests'));
    const payload = {
      playerUid: currentUser.uid,
      gameName: values.gameName.trim(),
      amount: requestAmount,
      baseAmount:
        values.baseAmount !== undefined && values.baseAmount !== null
          ? Number(values.baseAmount)
          : null,
      bonusPercentage:
        values.bonusPercentage !== undefined && values.bonusPercentage !== null
          ? Number(values.bonusPercentage)
          : null,
      bonusEventId: values.bonusEventId?.trim() || null,
      type: 'recharge' as const,
      status: 'pending' as const,
      createdBy: coadminUid,
      coadminUid,
      createdAt: serverTimestamp(),
      completedAt: null,
      pokedAt: null,
      pokeMessage: null,
      coinDeductedOnRequest: true,
    };

    await runTransaction(db, async (transaction) => {
      const playerMoneySnap = await transaction.get(playerRef);
      if (!playerMoneySnap.exists()) {
        throw new Error('Player profile not found.');
      }
      const currentCoin = Number(
        (playerMoneySnap.data() as { coin?: number }).coin || 0
      );
      if (currentCoin < requestAmount) {
        throw new Error(
          'Not enough coin to request this recharge. Use a lower amount or add coin first.'
        );
      }
      transaction.set(newRequestRef, payload);
      transaction.update(playerRef, {
        coin: currentCoin - requestAmount,
      });
    });

    const createdSnap = await getDoc(newRequestRef);
    if (createdSnap.exists()) {
      await upsertLinkedCarerTaskForRequest(
        mapRequestDoc(
          createdSnap.id,
          createdSnap.data() as Omit<PlayerGameRequest, 'id'>
        )
      );
    }
    return;
  }

  const redeemRef = await addDoc(collection(db, 'playerGameRequests'), {
    playerUid: currentUser.uid,
    gameName: values.gameName.trim(),
    amount: requestAmount,
    baseAmount:
      values.baseAmount !== undefined && values.baseAmount !== null
        ? Number(values.baseAmount)
        : null,
    bonusPercentage:
      values.bonusPercentage !== undefined && values.bonusPercentage !== null
        ? Number(values.bonusPercentage)
        : null,
    bonusEventId: values.bonusEventId?.trim() || null,
    type: values.type,
    status: 'pending',
    createdBy: coadminUid,
    coadminUid,
    createdAt: serverTimestamp(),
    completedAt: null,
    pokedAt: null,
    pokeMessage: null,
  });

  const redeemSnap = await getDoc(redeemRef);
  if (redeemSnap.exists()) {
    await upsertLinkedCarerTaskForRequest(
      mapRequestDoc(redeemSnap.id, redeemSnap.data() as Omit<PlayerGameRequest, 'id'>)
    );
  }
}

export async function getPendingPlayerGameRequests(
  playerUids: string[]
): Promise<PlayerGameRequest[]> {
  if (playerUids.length === 0) {
    return [];
  }

  const allRequests = await Promise.all(
    playerUids.map((playerUid) =>
      // Include legacy poked plus review-needed requests so task sync can recover them.
      getRequestsByStatuses(playerUid, ['pending', 'poked', 'pending_review'])
    )
  );

  return sortByNewest(allRequests.flat());
}

export async function getCompletedPlayerGameRequests(
  playerUids: string[]
): Promise<PlayerGameRequest[]> {
  if (playerUids.length === 0) {
    return [];
  }

  const allRequests = await Promise.all(
    playerUids.map((playerUid) => getRequestsByStatuses(playerUid, ['completed']))
  );

  return sortByNewest(allRequests.flat());
}

export async function getPendingPlayerGameRequestsByCoadmin(
  coadminUid: string
): Promise<PlayerGameRequest[]> {
  return getRequestsByCoadminAndStatuses(coadminUid, [
    'pending',
    'poked',
    'pending_review',
  ]);
}

export async function getCompletedPlayerGameRequestsByCoadmin(
  coadminUid: string
): Promise<PlayerGameRequest[]> {
  return getRequestsByCoadminAndStatuses(coadminUid, ['completed']);
}

export function listenToPlayerGameRequestsByPlayer(
  playerUid: string,
  onChange: (requests: PlayerGameRequest[]) => void,
  onError?: (error: Error) => void
) {
  const requestsQuery = query(
    collection(db, 'playerGameRequests'),
    where('playerUid', '==', playerUid)
  );

  return onSnapshot(
    requestsQuery,
    (snapshot) => {
      const requests = snapshot.docs.map((docSnap) =>
        mapRequestDoc(
          docSnap.id,
          docSnap.data() as Omit<PlayerGameRequest, 'id'>
        )
      );

      onChange(sortByNewest(requests));
    },
    (error) => {
      onError?.(error as Error);
    }
  );
}

export async function markPlayerGameRequestDone(requestId: string) {
  await updateDoc(doc(db, 'playerGameRequests', requestId), {
    status: 'completed',
    completedAt: serverTimestamp(),
    pokedAt: null,
    pokeMessage: null,
  });
  const snap = await getDoc(doc(db, 'playerGameRequests', requestId));
  if (snap.exists()) {
    await upsertLinkedCarerTaskForRequest(
      mapRequestDoc(snap.id, snap.data() as Omit<PlayerGameRequest, 'id'>)
    );
  }
}

export async function dismissPlayerRedeemRequest(requestId: string) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const requestRef = doc(db, 'playerGameRequests', requestId);
  const taskRef = doc(db, 'carerTasks', `request__${requestId}`);

  await runTransaction(db, async (transaction) => {
    const [requestSnap, taskSnap] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(taskRef),
    ]);

    if (!requestSnap.exists()) {
      throw new Error('Request not found.');
    }

    const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;

    if (requestData.playerUid !== currentUser.uid) {
      throw new Error('You can only dismiss your own request.');
    }

    if (requestData.type !== 'redeem') {
      throw new Error('Only redeem requests can be dismissed.');
    }

    if (requestData.status !== 'pending') {
      throw new Error('Only pending redeem requests can be dismissed.');
    }

    transaction.delete(requestRef);

    if (taskSnap.exists()) {
      transaction.delete(taskRef);
    }
  });
}

/**
 * Carers may dismiss a pending redeem when it appears fraudulent or mistaken.
 * Deletes the request and linked carer task; same data rules as player dismiss.
 */
export async function dismissPendingRedeemAsCarer(requestId: string) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const carerSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!carerSnap.exists()) {
    throw new Error('Profile not found.');
  }

  const carerRole = String(
    (carerSnap.data() as { role?: string }).role || ''
  ).toLowerCase();

  if (carerRole !== 'carer') {
    throw new Error('Only carers can dismiss pending redeem tasks this way.');
  }

  const carerCoadminUid = await getCurrentUserCoadminUid();

  const requestRef = doc(db, 'playerGameRequests', requestId);
  const taskRef = doc(db, 'carerTasks', `request__${requestId}`);

  await runTransaction(db, async (transaction) => {
    const [requestSnap, taskSnap] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(taskRef),
    ]);

    if (!requestSnap.exists()) {
      throw new Error('Request not found.');
    }

    const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;

    if (requestData.type !== 'redeem') {
      throw new Error('Only redeem requests can be dismissed.');
    }

    if (requestData.status !== 'pending') {
      throw new Error('Only pending redeem requests can be dismissed.');
    }

    const playerRef = doc(db, 'users', requestData.playerUid);
    const playerSnap = await transaction.get(playerRef);

    if (!playerSnap.exists()) {
      throw new Error('Player not found.');
    }

    const playerData = playerSnap.data() as CoadminScopedRecord;

    if (!belongsToCoadmin(playerData, carerCoadminUid)) {
      throw new Error('This request is outside your coadmin scope.');
    }

    transaction.delete(requestRef);

    if (taskSnap.exists()) {
      transaction.delete(taskRef);
    }
  });
}
