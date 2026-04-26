import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
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
};

function mapRequestDoc(docId: string, value: Omit<PlayerGameRequest, 'id'>) {
  return {
    id: docId,
    ...value,
  } satisfies PlayerGameRequest;
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

async function assertCurrentPlayerIsActive(playerUid: string) {
  const playerSnap = await getDoc(doc(db, 'users', playerUid));

  if (!playerSnap.exists()) {
    throw new Error('Player profile not found.');
  }

  const playerData = playerSnap.data() as { status?: string };

  if (playerData.status === 'disabled') {
    throw new Error(
      'Your account is blocked. Recharge, redeem, and poke features are disabled.'
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

  const coadminUid = await getCurrentUserCoadminUid();

  await addDoc(collection(db, 'playerGameRequests'), {
    playerUid: currentUser.uid,
    gameName: values.gameName.trim(),
    amount: values.amount,
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
}

export async function getPendingPlayerGameRequests(
  playerUids: string[]
): Promise<PlayerGameRequest[]> {
  if (playerUids.length === 0) {
    return [];
  }

  const allRequests = await Promise.all(
    playerUids.map((playerUid) =>
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

export function listenToPlayerGameRequestsByPlayer(
  playerUid: string,
  onChange: (requests: PlayerGameRequest[]) => void,
  onError?: (error: Error) => void
) {
  const requestsQuery = query(
    collection(db, 'playerGameRequests'),
    where('playerUid', '==', playerUid),
    orderBy('createdAt', 'desc')
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

export function listenToUrgentPlayerGameRequestsByCoadmin(
  coadminUid: string,
  onChange: (requests: PlayerGameRequest[]) => void,
  onError?: (error: Error) => void
) {
  const requestsQuery = query(
    collection(db, 'playerGameRequests'),
    where('coadminUid', '==', coadminUid),
    orderBy('createdAt', 'desc')
  );

  return onSnapshot(
    requestsQuery,
    (snapshot) => {
      const requests = snapshot.docs
        .map((docSnap) =>
          mapRequestDoc(
            docSnap.id,
            docSnap.data() as Omit<PlayerGameRequest, 'id'>
          )
        )
        .filter(
          (request) =>
            request.status === 'poked' || request.status === 'pending_review'
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
}

export async function pokePlayerGameRequest(
  requestId: string,
  pokeMessage?: string
) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  await assertCurrentPlayerIsActive(currentUser.uid);

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

    if (!taskSnap.exists()) {
      throw new Error('Related carer task not found.');
    }

    const requestData = requestSnap.data() as Omit<PlayerGameRequest, 'id'>;
    const taskData = taskSnap.data() as {
      type?: PlayerGameRequestType;
      requestId?: string | null;
      status?: string;
      assignedCarerUid?: string | null;
      assignedCarerUsername?: string | null;
      completedByCarerUid?: string | null;
      completedByCarerUsername?: string | null;
      completedAt?: Timestamp | null;
    };

    if (requestData.playerUid !== currentUser.uid) {
      throw new Error('You can only poke your own request.');
    }

    if (
      requestData.type !== 'recharge' &&
      requestData.type !== 'redeem'
    ) {
      throw new Error('Only recharge and redeem requests can be poked.');
    }

    if (requestData.status !== 'completed') {
      throw new Error('Only completed requests can be poked.');
    }

    if (taskData.requestId !== requestId || taskData.status !== 'completed') {
      throw new Error('Only completed carer tasks can be poked.');
    }

    const originalCarerUid =
      taskData.completedByCarerUid || taskData.assignedCarerUid || null;
    const originalCarerUsername =
      taskData.completedByCarerUsername || taskData.assignedCarerUsername || null;

    if (!originalCarerUid) {
      throw new Error('The original completing carer could not be determined.');
    }

    const now = Timestamp.now();
    const nextPokeMessage = pokeMessage?.trim() || null;
    const previousCompletedAt = taskData.completedAt || requestData.completedAt || now;

    transaction.update(taskRef, {
      status: 'urgent',
      isPoked: true,
      pokedAt: now,
      pokeMessage: nextPokeMessage,
      assignedCarerUid: originalCarerUid,
      assignedCarerUsername: originalCarerUsername,
      completedByCarerUid: originalCarerUid,
      completedByCarerUsername: originalCarerUsername,
      completedAt: previousCompletedAt,
      startedAt: null,
      expiresAt: null,
    });

    transaction.update(requestRef, {
      status: 'poked',
      pokedAt: now,
      pokeMessage: nextPokeMessage,
    });
  });
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
