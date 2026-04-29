import {
  Timestamp,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { recordFinancialEvent } from '@/features/risk/playerRisk';

export type PlayerCashoutTaskStatus = 'pending' | 'in_progress' | 'completed';
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
  status: PlayerCashoutTaskStatus;
  assignedHandlerUid?: string | null;
  assignedHandlerUsername?: string | null;
  startedAt?: Timestamp | null;
  expiresAt?: Timestamp | null;
  createdAt?: Timestamp | null;
  completedAt?: Timestamp | null;
};

const TASK_DURATION_MS = 3 * 60 * 1000;

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

async function getCurrentUserIdentity() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const userData = userSnap.data() as { username?: string };

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'Handler',
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

    transaction.update(playerRef, {
      cash: 0,
    });

    transaction.set(taskRef, {
      coadminUid: values.coadminUid,
      playerUid: currentUser.uid,
      playerUsername: playerData.username?.trim() || 'Player',
      amountNpr: availableCash,
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

    if (effectiveStatus !== 'in_progress' || taskData.assignedHandlerUid !== identity.uid) {
      throw new Error('Only assigned handler can complete this task.');
    }

    const requestedAmount = Number(taskData.amountNpr || 0);
    const shouldDeductOnComplete = !Boolean(taskData.cashDeductedOnRequest);
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

    const rewardNpr = Math.max(1, Math.round(Number(taskData.amountNpr || 0) * 0.015));
    const handlerData = handlerSnap.exists()
      ? (handlerSnap.data() as { cashBoxNpr?: number })
      : { cashBoxNpr: 0 };

    transaction.update(taskRef, {
      status: 'completed',
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
        cashBoxNpr: Number(handlerData.cashBoxNpr || 0) + rewardNpr,
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

function sortByNewest(tasks: PlayerCashoutTask[]) {
  return [...tasks].sort((left, right) => getSnapshotMs(right.createdAt) - getSnapshotMs(left.createdAt));
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
