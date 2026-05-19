import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
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
import { completedPlayerGameRequestTtl } from '@/lib/firestore/ttl';

export type PlayerGameRequestType = 'recharge' | 'redeem';
export type PlayerGameRequestStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'poked'
  | 'pending_review'
  | 'dismissed';

export type PlayerGameRequest = {
  id: string;
  playerUid: string;
  gameName: string;
  currentUsername?: string | null;
  gameAccountUsername?: string | null;
  amount: number;
  baseAmount?: number | null;
  bonusPercentage?: number | null;
  bonusEventId?: string | null;
  firstRechargeMatchApplied?: boolean | null;
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
  coinRefundedOnDismissal?: boolean | null;
};

type PlayerGameRedeemLimitReset = {
  playerUid: string;
  gameName: string;
  resetAt?: Timestamp | null;
  resetByUid?: string | null;
  coadminUid?: string | null;
};

export type PlayerGameRedeemLimitSummary = {
  gameName: string;
  usedAmount: number;
  remainingAmount: number;
  onLimit: boolean;
  windowStartedAtMs: number;
  resetAtMs: number;
};

export const MIN_REDEEM_AMOUNT = 50;
export const MAX_REDEEM_AMOUNT = 350;
export const PLAYER_GAME_REDEEM_MAX_PER_24H = 350;
export const PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeGameName(gameName: string) {
  return gameName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function getRedeemLimitResetDocId(playerUid: string, gameName: string) {
  return `${String(playerUid || '').trim()}__${encodeURIComponent(
    String(gameName || '').trim()
  )}`;
}

function getTimestampMs(value?: Timestamp | null) {
  return value?.toMillis?.() || 0;
}

async function fetchRedeemLimitResetForPlayerGame(
  playerUid: string,
  gameName: string
): Promise<PlayerGameRedeemLimitReset | null> {
  const cleanPlayerUid = String(playerUid || '').trim();
  const cleanGameName = String(gameName || '').trim();
  if (!cleanPlayerUid || !cleanGameName) {
    return null;
  }

  const resetSnap = await getDoc(
    doc(
      db,
      'playerGameRedeemLimitResets',
      getRedeemLimitResetDocId(cleanPlayerUid, cleanGameName)
    )
  );

  if (!resetSnap.exists()) {
    return null;
  }

  return resetSnap.data() as PlayerGameRedeemLimitReset;
}

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
    'message' in payload &&
    typeof (payload as { message?: unknown }).message === 'string'
  ) {
    return String((payload as { message: string }).message || messageFallback);
  }
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

async function fetchRolling24hRedeemUsageForPlayerGame(
  playerUid: string,
  gameName: string
) {
  const cleanGameName = String(gameName || '').trim();
  const cleanPlayerUid = String(playerUid || '').trim();
  if (!cleanPlayerUid || !cleanGameName) {
    return 0;
  }

  const sinceMillis = Date.now() - PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS;
  const resetRecord = await fetchRedeemLimitResetForPlayerGame(
    cleanPlayerUid,
    cleanGameName
  );
  const resetAtMs = getTimestampMs(resetRecord?.resetAt || null);
  const effectiveSinceMillis = Math.max(sinceMillis, resetAtMs);
  const redeemQuery = query(
    collection(db, 'playerGameRequests'),
    where('playerUid', '==', cleanPlayerUid),
    where('type', '==', 'redeem'),
    where('gameName', '==', cleanGameName),
    where('createdAt', '>=', Timestamp.fromMillis(sinceMillis))
  );
  const snapshot = await getDocs(redeemQuery);
  let total = 0;

  snapshot.forEach((docSnap) => {
    const data = docSnap.data() as {
      status?: string;
      amount?: number;
      createdAt?: Timestamp | null;
    };
    const status = String(data.status || '').toLowerCase();
    if (status === 'dismissed' || status === 'failed') {
      return;
    }
    if (getTimestampMs(data.createdAt || null) < effectiveSinceMillis) {
      return;
    }
    total += Math.max(0, Number(data.amount || 0));
  });

  return total;
}

export async function getPlayerGameRedeemLimitSummary(
  playerUid: string,
  gameName: string
): Promise<PlayerGameRedeemLimitSummary> {
  const cleanGameName = String(gameName || '').trim();
  const usedAmount = await fetchRolling24hRedeemUsageForPlayerGame(
    playerUid,
    cleanGameName
  );
  const remainingAmount = Math.max(
    0,
    PLAYER_GAME_REDEEM_MAX_PER_24H - usedAmount
  );
  const resetRecord = await fetchRedeemLimitResetForPlayerGame(
    playerUid,
    cleanGameName
  );
  const resetAtMs = getTimestampMs(resetRecord?.resetAt || null);

  return {
    gameName: cleanGameName,
    usedAmount: Math.round(usedAmount),
    remainingAmount: Math.round(remainingAmount),
    onLimit: remainingAmount <= 0,
    windowStartedAtMs: Math.max(
      Date.now() - PLAYER_GAME_REDEEM_ROLLING_WINDOW_MS,
      resetAtMs
    ),
    resetAtMs,
  };
}

export async function resetPlayerGameRedeemLimitForCoadmin(
  playerUid: string,
  gameName: string
) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const cleanPlayerUid = String(playerUid || '').trim();
  const cleanGameName = String(gameName || '').trim();
  if (!cleanPlayerUid || !cleanGameName) {
    throw new Error('Player and game are required.');
  }

  const coadminUid = await getCurrentUserCoadminUid();
  if (!coadminUid.trim()) {
    throw new Error('Coadmin scope not found.');
  }

  const playerSnap = await getDoc(doc(db, 'users', cleanPlayerUid));
  if (!playerSnap.exists()) {
    throw new Error('Player profile not found.');
  }

  const playerData = playerSnap.data() as CoadminScopedRecord;
  if (!belongsToCoadmin(playerData, coadminUid)) {
    throw new Error('This player is outside your coadmin scope.');
  }

  await setDoc(
    doc(
      db,
      'playerGameRedeemLimitResets',
      getRedeemLimitResetDocId(cleanPlayerUid, cleanGameName)
    ),
    {
      playerUid: cleanPlayerUid,
      gameName: cleanGameName,
      resetAt: Timestamp.now(),
      resetByUid: currentUser.uid,
      coadminUid,
    } satisfies PlayerGameRedeemLimitReset
  );
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
  const cleanGameName = values.gameName.trim();
  if (values.type === 'recharge') {
    const response = await fetch('/api/player/game-requests/recharge', {
      method: 'POST',
      headers: await getAuthHeaders(),
      body: JSON.stringify({
        gameName: cleanGameName,
        amount: requestAmount,
        baseAmount: values.baseAmount,
        bonusPercentage: values.bonusPercentage,
        bonusEventId: values.bonusEventId,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; requestId?: string };
    if (!response.ok) {
      throw new Error(readApiError('Failed to create recharge request.', payload));
    }

    const createdRequestId = String(payload.requestId || '').trim();
    if (!createdRequestId) {
      throw new Error('Recharge request was created but request ID was missing.');
    }
    const createdSnap = await getDoc(doc(db, 'playerGameRequests', createdRequestId));
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

  if (requestAmount > MAX_REDEEM_AMOUNT) {
    throw new Error(
      `Redeem amount must not be more than ${MAX_REDEEM_AMOUNT}.`
    );
  }

  if (requestAmount < MIN_REDEEM_AMOUNT) {
    throw new Error(
      `Redeem amount must be between ${MIN_REDEEM_AMOUNT} and ${MAX_REDEEM_AMOUNT}.`
    );
  }

  const rollingRedeemUsed = await fetchRolling24hRedeemUsageForPlayerGame(
    currentUser.uid,
    cleanGameName
  );
  const redeemRemaining = Math.max(
    0,
    PLAYER_GAME_REDEEM_MAX_PER_24H - rollingRedeemUsed
  );

  if (redeemRemaining <= 0) {
    throw new Error(
      `Redeem limit for ${cleanGameName} is ${PLAYER_GAME_REDEEM_MAX_PER_24H} per rolling 24 hours. Wait until older redeems expire from this game window before redeeming again.`
    );
  }

  if (requestAmount > redeemRemaining) {
    throw new Error(
      `Only ${redeemRemaining} redeem is left for ${cleanGameName} in this rolling 24-hour window.`
    );
  }

  const response = await fetch('/api/player/game-requests/redeem', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      gameName: cleanGameName,
      amount: requestAmount,
      baseAmount: values.baseAmount,
      bonusPercentage: values.bonusPercentage,
      bonusEventId: values.bonusEventId,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; requestId?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to create redeem request.', payload));
  }

  const createdRequestId = String(payload.requestId || '').trim();
  if (!createdRequestId) {
    throw new Error('Redeem request was created but request ID was missing.');
  }
  const redeemSnap = await getDoc(doc(db, 'playerGameRequests', createdRequestId));
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
    ttlExpiresAt: completedPlayerGameRequestTtl(),
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

    transaction.update(requestRef, {
      status: 'dismissed',
      completedAt: serverTimestamp(),
      ttlExpiresAt: completedPlayerGameRequestTtl(),
      pokedAt: null,
      pokeMessage: null,
    });

    if (taskSnap.exists()) {
      transaction.delete(taskRef);
    }
  });
}

/**
 * Carers may dismiss a pending redeem when it appears fraudulent or mistaken.
 * Marks the request dismissed and removes the linked carer task.
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
    const playerCoin = Number((playerData as { coin?: number }).coin || 0);

    if (!belongsToCoadmin(playerData, carerCoadminUid)) {
      throw new Error('This request is outside your coadmin scope.');
    }

    transaction.update(requestRef, {
      status: 'dismissed',
      completedAt: serverTimestamp(),
      ttlExpiresAt: completedPlayerGameRequestTtl(),
      pokedAt: null,
      pokeMessage: null,
    });

    if (taskSnap.exists()) {
      transaction.delete(taskRef);
    }
  });
}

/**
 * Carers may dismiss a pending recharge manually when they decide to remove it.
 * Marks the request dismissed and removes the linked carer task.
 */
export async function dismissPendingRechargeAsCarer(requestId: string) {
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
    throw new Error('Only carers can dismiss pending recharge tasks this way.');
  }

  const response = await fetch('/api/carer/game-requests/dismiss-recharge', {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify({ requestId }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(readApiError('Failed to dismiss recharge request.', payload));
  }
}
