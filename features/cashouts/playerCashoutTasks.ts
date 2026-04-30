import {
  arrayUnion,
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { evaluateWithdrawalPolicy } from '@/lib/economy/policy';
import { recordFinancialEvent } from '@/features/risk/playerRisk';

export type PlayerCashoutTaskStatus = 'pending' | 'in_progress' | 'completed' | 'declined';
export type PlayerCashoutPayoutMethod = 'qr' | 'app';

export type PlayerCashoutTask = {
  id: string;
  coadminUid: string;
  playerUid: string;
  playerUsername: string;
  amountNpr: number;
  paymentDetails: string;
  payoutMethod?: PlayerCashoutPayoutMethod | null;
  qrImageUrl?: string | null;
  paymentAppName?: string | null;
  paymentAppCashTag?: string | null;
  paymentAppAccountName?: string | null;
  cashDeductedOnRequest?: boolean;
  declinedByUids?: string[];
  status: PlayerCashoutTaskStatus;
  assignedHandlerUid?: string | null;
  assignedHandlerUsername?: string | null;
  startedAt?: Timestamp | null;
  expiresAt?: Timestamp | null;
  createdAt?: Timestamp | null;
  completedAt?: Timestamp | null;
};

const TASK_DURATION_MS = 3 * 60 * 1000;

/** Max NPR a player may cash out in a rolling ~24-hour window (sums non-declined task amounts). */
export const PLAYER_CASHOUT_MAX_NPR_PER_24_H = 1000;
export const PLAYER_CASHOUT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Sum non-declined player cashouts with `createdAt` in [now − 24h, now]. */
export function rolling24hCashoutUsageNprFromTasks(
  tasks: PlayerCashoutTask[],
  nowMs: number = Date.now()
): number {
  const since = nowMs - PLAYER_CASHOUT_ROLLING_WINDOW_MS;
  let total = 0;
  for (const task of tasks) {
    const created = getSnapshotMs(task.createdAt);
    if (!created || created < since) {
      continue;
    }
    if (task.status === 'declined') {
      continue;
    }
    total += Math.max(0, Number(task.amountNpr || 0));
  }
  return total;
}

async function fetchRolling24hCashoutUsageNprForPlayer(playerUid: string): Promise<number> {
  const sinceMillis = Date.now() - PLAYER_CASHOUT_ROLLING_WINDOW_MS;
  const q = query(
    collection(db, 'playerCashoutTasks'),
    where('playerUid', '==', playerUid),
    where('createdAt', '>=', Timestamp.fromMillis(sinceMillis))
  );
  const snapshot = await getDocs(q);
  let total = 0;
  snapshot.forEach((docSnap) => {
    const data = docSnap.data() as { status?: string; amountNpr?: number };
    if (String(data.status || '') === 'declined') {
      return;
    }
    total += Math.max(0, Number(data.amountNpr || 0));
  });
  return total;
}

async function fetchCompletedCashoutCountForPlayer(playerUid: string): Promise<number> {
  const q = query(
    collection(db, 'playerCashoutTasks'),
    where('playerUid', '==', playerUid),
    where('status', '==', 'completed')
  );
  const snapshot = await getDocs(q);
  return snapshot.size;
}

async function fetchLatestCompletedRechargeAmountForPlayer(playerUid: string): Promise<number> {
  const q = query(
    collection(db, 'playerGameRequests'),
    where('playerUid', '==', playerUid),
    where('type', '==', 'recharge'),
    where('status', '==', 'completed'),
    orderBy('completedAt', 'desc'),
    limit(1)
  );

  try {
    const snapshot = await getDocs(q);
    const latest = snapshot.docs[0]?.data() as { amount?: number } | undefined;
    return Math.max(0, Math.round(Number(latest?.amount || 0)));
  } catch {
    const fallback = await getDocs(
      query(
        collection(db, 'playerGameRequests'),
        where('playerUid', '==', playerUid),
        where('type', '==', 'recharge'),
        where('status', '==', 'completed')
      )
    );

    const sorted = fallback.docs
      .map((docSnap) => {
        const data = docSnap.data() as {
          amount?: number;
          completedAt?: Timestamp | null;
          createdAt?: Timestamp | null;
        };
        return {
          amount: Math.max(0, Math.round(Number(data.amount || 0))),
          sortMs: Math.max(
            data.completedAt?.toMillis?.() || 0,
            data.createdAt?.toMillis?.() || 0
          ),
        };
      })
      .sort((left, right) => right.sortMs - left.sortMs);

    return sorted[0]?.amount || 0;
  }
}

function toTask(docId: string, value: Omit<PlayerCashoutTask, 'id'>): PlayerCashoutTask {
  return { id: docId, ...value };
}

function getSnapshotMs(value?: Timestamp | null) {
  return value?.toMillis?.() || 0;
}

export function getPlayerCashoutPaymentDisplay(task: PlayerCashoutTask) {
  const rawText = String(task.paymentDetails || '').trim();
  const method = task.payoutMethod || null;
  const qrImageUrl = String(task.qrImageUrl || '').trim() || null;
  const paymentAppName = String(task.paymentAppName || '').trim() || null;
  const paymentAppCashTag = String(task.paymentAppCashTag || '').trim() || null;
  const paymentAppAccountName = String(task.paymentAppAccountName || '').trim() || null;

  if (method === 'qr' || qrImageUrl) {
    return {
      method: 'qr' as const,
      qrImageUrl,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
      rawText,
    };
  }

  if (
    method === 'app' ||
    paymentAppName ||
    paymentAppCashTag ||
    paymentAppAccountName
  ) {
    return {
      method: 'app' as const,
      qrImageUrl: null,
      paymentAppName,
      paymentAppCashTag,
      paymentAppAccountName,
      rawText,
    };
  }

  if (/Payout method:\s*QR/i.test(rawText)) {
    const qrMatch = rawText.match(/QR image:\s*(.+)/i);
    return {
      method: 'qr' as const,
      qrImageUrl: qrMatch?.[1]?.trim() || null,
      paymentAppName: null,
      paymentAppCashTag: null,
      paymentAppAccountName: null,
      rawText,
    };
  }

  if (/Payout method:\s*Payment app/i.test(rawText)) {
    const appNameMatch = rawText.match(/App name:\s*(.+)/i);
    const cashTagMatch = rawText.match(/Cash tag:\s*(.+)/i);
    const accountNameMatch = rawText.match(/Name on app:\s*(.+)/i);
    return {
      method: 'app' as const,
      qrImageUrl: null,
      paymentAppName: appNameMatch?.[1]?.trim() || null,
      paymentAppCashTag: cashTagMatch?.[1]?.trim() || null,
      paymentAppAccountName: accountNameMatch?.[1]?.trim() || null,
      rawText,
    };
  }

  return {
    method: null,
    qrImageUrl: null,
    paymentAppName: null,
    paymentAppCashTag: null,
    paymentAppAccountName: null,
    rawText,
  };
}

export function getEffectivePlayerCashoutTaskStatus(task: PlayerCashoutTask) {
  if (
    task.status === 'in_progress' &&
    task.expiresAt &&
    task.expiresAt.toMillis() <= Date.now()
  ) {
    return 'pending' as const;
  }

  return task.status;
}

export function getPlayerCashoutTaskCountdown(task: PlayerCashoutTask) {
  if (task.status !== 'in_progress' || !task.expiresAt) {
    return 0;
  }

  return Math.max(0, task.expiresAt.toMillis() - Date.now());
}

/**
 * When a task is in progress under another handler's claim, hide from other viewers' active lists.
 * Expired windows still report effective `pending`, so competing staff can reclaim.
 */
export function isPlayerCashoutHandledBySomeoneElse(task: PlayerCashoutTask, viewerUid: string) {
  const effective = getEffectivePlayerCashoutTaskStatus(task);
  if (effective !== 'in_progress') {
    return false;
  }

  const handlerUid = String(task.assignedHandlerUid || '').trim();
  if (!handlerUid) {
    return false;
  }

  return handlerUid !== String(viewerUid || '').trim();
}

async function getCurrentUserIdentity() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const userData = userSnap.data() as { username?: string; role?: string };

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'Handler',
    role: String(userData.role || '').toLowerCase(),
  };
}

export async function createPlayerCashoutTask(values: {
  coadminUid: string;
  paymentDetails: string;
  payoutMethod?: PlayerCashoutPayoutMethod;
  qrImageUrl?: string;
  paymentAppName?: string;
  paymentAppCashTag?: string;
  paymentAppAccountName?: string;
}) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const paymentDetails = values.paymentDetails.trim();

  if (paymentDetails.length < 5) {
    throw new Error('Please provide clear payment details.');
  }

  const rollingUsed = await fetchRolling24hCashoutUsageNprForPlayer(currentUser.uid);
  const [completedCashoutCount, lastRechargeAmountNpr] = await Promise.all([
    fetchCompletedCashoutCountForPlayer(currentUser.uid),
    fetchLatestCompletedRechargeAmountForPlayer(currentUser.uid),
  ]);
  const remainingQuota = Math.max(
    0,
    PLAYER_CASHOUT_MAX_NPR_PER_24_H - rollingUsed
  );

  const playerRef = doc(db, 'users', currentUser.uid);
  const taskRef = doc(collection(db, 'playerCashoutTasks'));

  await runTransaction(db, async (transaction) => {
    const playerSnap = await transaction.get(playerRef);

    if (!playerSnap.exists()) {
      throw new Error('Player profile not found.');
    }

    const playerData = playerSnap.data() as {
      role?: string;
      username?: string;
      cash?: number;
    };
    const availableCash = Number(playerData.cash || 0);

    if (String(playerData.role || '').toLowerCase() !== 'player') {
      throw new Error('Only players can create cashout tasks.');
    }

    if (availableCash <= 0) {
      throw new Error('No cash available to cash out.');
    }

    const amountThisRequest = Math.min(availableCash, remainingQuota);

    if (amountThisRequest <= 0) {
      throw new Error(
        `Rolling 24-hour cash out limit (${PLAYER_CASHOUT_MAX_NPR_PER_24_H} NPR) is reached for now. You've already requested ${rollingUsed.toFixed(2)} NPR in the window. Wait until older requests expire from this window before cashing out more.`
      );
    }

    const decision = evaluateWithdrawalPolicy({
      amountNpr: amountThisRequest,
      completedWithdrawalCount: completedCashoutCount,
      lastRechargeAmountNpr,
    });
    if (!decision.allowed) {
      throw new Error(decision.message);
    }

    transaction.update(playerRef, {
      cash: availableCash - amountThisRequest,
    });

    transaction.set(taskRef, {
      coadminUid: values.coadminUid,
      playerUid: currentUser.uid,
      playerUsername: playerData.username?.trim() || 'Player',
      amountNpr: amountThisRequest,
      paymentDetails,
      payoutMethod: values.payoutMethod || null,
      qrImageUrl: values.qrImageUrl?.trim() || null,
      paymentAppName: values.paymentAppName?.trim() || null,
      paymentAppCashTag: values.paymentAppCashTag?.trim() || null,
      paymentAppAccountName: values.paymentAppAccountName?.trim() || null,
      cashDeductedOnRequest: true,
      status: 'pending',
      assignedHandlerUid: null,
      assignedHandlerUsername: null,
      startedAt: null,
      expiresAt: null,
      createdAt: serverTimestamp(),
      completedAt: null,
    });
  });
}

export async function startPlayerCashoutTask(taskId: string) {
  const identity = await getCurrentUserIdentity();
  const taskRef = doc(db, 'playerCashoutTasks', taskId);

  await runTransaction(db, async (transaction) => {
    const taskSnap = await transaction.get(taskRef);

    if (!taskSnap.exists()) {
      throw new Error('Cashout task not found.');
    }

    const taskData = taskSnap.data() as Omit<PlayerCashoutTask, 'id'>;
    const effectiveStatus = getEffectivePlayerCashoutTaskStatus(
      toTask(taskSnap.id, taskData)
    );

    if (
      effectiveStatus === 'in_progress' &&
      taskData.assignedHandlerUid &&
      taskData.assignedHandlerUid !== identity.uid
    ) {
      throw new Error('This task is already assigned to another handler.');
    }

    if (effectiveStatus === 'completed') {
      throw new Error('Task already completed.');
    }

    const now = Timestamp.now();
    transaction.update(taskRef, {
      status: 'in_progress',
      assignedHandlerUid: identity.uid,
      assignedHandlerUsername: identity.username,
      startedAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + TASK_DURATION_MS),
    });
  });
}

export async function completePlayerCashoutTask(taskId: string) {
  const identity = await getCurrentUserIdentity();
  const taskRef = doc(db, 'playerCashoutTasks', taskId);
  const handlerRef = doc(db, 'users', identity.uid);
  let completedPlayerUid = '';
  let completedCoadminUid = '';
  let completedAmountNpr = 0;

  await runTransaction(db, async (transaction) => {
    const [taskSnap, handlerSnap] = await Promise.all([
      transaction.get(taskRef),
      transaction.get(handlerRef),
    ]);

    if (!taskSnap.exists()) {
      throw new Error('Cashout task not found.');
    }

    const taskData = taskSnap.data() as Omit<PlayerCashoutTask, 'id'>;
    const effectiveStatus = getEffectivePlayerCashoutTaskStatus(
      toTask(taskSnap.id, taskData)
    );

    if (effectiveStatus !== 'in_progress' && effectiveStatus !== 'pending') {
      throw new Error('Cashout task is not available to complete.');
    }

    const requestedAmount = Number(taskData.amountNpr || 0);
    const shouldDeductOnComplete = taskData.cashDeductedOnRequest === false;
    let playerRef: ReturnType<typeof doc> | null = null;
    let playerCash = 0;

    if (shouldDeductOnComplete) {
      playerRef = doc(db, 'users', taskData.playerUid);
      const playerSnap = await transaction.get(playerRef);

      if (!playerSnap.exists()) {
        transaction.delete(taskRef);
        throw new Error(
          'Cashout task dismissed: player profile not found or cash balance unavailable.'
        );
      }

      const playerData = playerSnap.data() as { cash?: number };
      playerCash = Number(playerData.cash);
    }

    if (
      !Number.isFinite(requestedAmount) ||
      requestedAmount <= 0
    ) {
      transaction.delete(taskRef);
      throw new Error(
        'Cashout task dismissed: player cash balance is invalid for this request.'
      );
    }

    if (shouldDeductOnComplete && (playerCash < 0 || !Number.isFinite(playerCash) || playerCash < requestedAmount)) {
      transaction.delete(taskRef);
      throw new Error(
        'Cashout task dismissed: player cash balance is lower than the requested amount.'
      );
    }

    const rewardNpr = Math.max(1, Math.round(Number(taskData.amountNpr || 0) * 0.05));
    const handlerCreditAmount = requestedAmount + rewardNpr;
    const handlerData = handlerSnap.exists()
      ? (handlerSnap.data() as { cashBoxNpr?: number })
      : { cashBoxNpr: 0 };

    const now = Timestamp.now();
    transaction.update(taskRef, {
      status: 'completed',
      assignedHandlerUid: identity.uid,
      assignedHandlerUsername: identity.username,
      cashoutRequestedByStaffId: identity.role === 'staff' ? identity.uid : null,
      startedAt: taskData.startedAt || now,
      expiresAt: null,
      completedAt: serverTimestamp(),
    });
    if (shouldDeductOnComplete && playerRef) {
      transaction.update(playerRef, {
        cash: playerCash - requestedAmount,
      });
    }
    transaction.set(
      handlerRef,
      {
        cashBoxNpr: Number(handlerData.cashBoxNpr || 0) + handlerCreditAmount,
      },
      { merge: true }
    );

    completedPlayerUid = taskData.playerUid;
    completedCoadminUid = taskData.coadminUid;
    completedAmountNpr = requestedAmount;
  });

  if (completedPlayerUid && completedAmountNpr > 0) {
    await recordFinancialEvent({
      playerUid: completedPlayerUid,
      coadminUid: completedCoadminUid,
      amountNpr: completedAmountNpr,
      type: 'cashout',
    });
  }
}

export async function declinePlayerCashoutTaskForCurrentHandler(taskId: string) {
  const identity = await getCurrentUserIdentity();
  const taskRef = doc(db, 'playerCashoutTasks', taskId);
  await updateDoc(taskRef, {
    declinedByUids: arrayUnion(identity.uid),
  });
}

export async function declinePlayerCashoutTaskByCoadmin(taskId: string) {
  const taskRef = doc(db, 'playerCashoutTasks', taskId);

  await runTransaction(db, async (transaction) => {
    const taskSnap = await transaction.get(taskRef);

    if (!taskSnap.exists()) {
      throw new Error('Cashout task not found.');
    }

    const taskData = taskSnap.data() as Omit<PlayerCashoutTask, 'id'>;
    const effectiveStatus = getEffectivePlayerCashoutTaskStatus(toTask(taskSnap.id, taskData));

    if (effectiveStatus !== 'pending' && effectiveStatus !== 'in_progress') {
      throw new Error('Only active cashout tasks can be declined.');
    }

    const amountNpr = Math.max(0, Math.round(Number(taskData.amountNpr || 0)));
    const playerRef = doc(db, 'users', taskData.playerUid);
    const playerSnap = await transaction.get(playerRef);
    const playerCash = playerSnap.exists()
      ? Math.max(0, Number((playerSnap.data() as { cash?: number }).cash || 0))
      : 0;

    transaction.update(taskRef, {
      status: 'declined',
      expiresAt: null,
      completedAt: serverTimestamp(),
    });

    // Refund declined player cashout back to player's cash balance.
    if (taskData.cashDeductedOnRequest === true && amountNpr > 0) {
      transaction.set(
        playerRef,
        {
          cash: playerCash + amountNpr,
        },
        { merge: true }
      );
    }
  });
}

function sortByNewest(tasks: PlayerCashoutTask[]) {
  return [...tasks].sort((left, right) => getSnapshotMs(right.createdAt) - getSnapshotMs(left.createdAt));
}

function getTaskLedgerSortMs(task: PlayerCashoutTask) {
  return Math.max(getSnapshotMs(task.completedAt), getSnapshotMs(task.createdAt));
}

function sortByLedgerNewest(tasks: PlayerCashoutTask[]) {
  return [...tasks].sort(
    (left, right) => getTaskLedgerSortMs(right) - getTaskLedgerSortMs(left)
  );
}

/** Player payout tasks claimed or completed by a specific staff/carer handler. */
export function listenPlayerCashoutTasksByAssignedHandler(
  assignedHandlerUid: string,
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  const tasksQuery = query(
    collection(db, 'playerCashoutTasks'),
    where('assignedHandlerUid', '==', assignedHandlerUid)
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs.map((docSnap) =>
        toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>)
      );
      onChange(sortByLedgerNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}

export function listenPlayerCashoutTasksByCoadmin(
  coadminUid: string,
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  const tasksQuery = query(
    collection(db, 'playerCashoutTasks'),
    where('coadminUid', '==', coadminUid)
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs
        .map((docSnap) => toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>));
      onChange(sortByNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}

export function listenAllPlayerCashoutTasks(
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  const tasksQuery = query(collection(db, 'playerCashoutTasks'));

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs
        .map((docSnap) => toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>));
      onChange(sortByNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}

export function listenPlayerCashoutTasksByPlayer(
  playerUid: string,
  onChange: (tasks: PlayerCashoutTask[]) => void,
  onError?: (error: Error) => void
) {
  const tasksQuery = query(
    collection(db, 'playerCashoutTasks'),
    where('playerUid', '==', playerUid)
  );

  return onSnapshot(
    tasksQuery,
    (snapshot) => {
      const tasks = snapshot.docs.map((docSnap) =>
        toTask(docSnap.id, docSnap.data() as Omit<PlayerCashoutTask, 'id'>)
      );
      onChange(sortByNewest(tasks));
    },
    (error) => onError?.(error as Error)
  );
}
