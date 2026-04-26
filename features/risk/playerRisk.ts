import {
  Timestamp,
  addDoc,
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
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { resolveCoadminUid } from '@/lib/coadmin/scope';

export type RiskLevel = 'low' | 'medium' | 'high';
export type TransferRequestStatus = 'pending' | 'approved' | 'rejected';
export type FinancialEventType =
  | 'deposit'
  | 'cashout'
  | 'transfer'
  | 'bonus'
  | 'recharge'
  | 'redeem';

export type FinancialActivityWindow = {
  cashouts: number;
  transfers: number;
  bonus: number;
  deposits: number;
};

export type TransferRequest = {
  id: string;
  playerUid: string;
  playerUsername: string;
  coadminUid: string;
  amountNpr: number;
  cashBalanceSnapshot: number;
  status: TransferRequestStatus;
  requestedByUid: string;
  requestedByUsername: string;
  requestedAt?: Timestamp | null;
  approvedByUid?: string | null;
  approvedByUsername?: string | null;
  approvedAt?: Timestamp | null;
  rejectedByUid?: string | null;
  rejectedByUsername?: string | null;
  rejectedAt?: Timestamp | null;
  rejectionReason?: string | null;
  autoApproved?: boolean;
  reviewed?: boolean;
  processedAt?: Timestamp | null;
};

type FinancialEvent = {
  playerUid: string;
  coadminUid: string;
  amountNpr: number;
  type: FinancialEventType;
  createdAt?: Timestamp | null;
};

type HistoricalSourceRow = {
  amountNpr: number;
  createdAt?: Timestamp | null;
  type: FinancialEventType;
};

export type PlayerRiskSnapshot = {
  playerUid: string;
  playerUsername: string;
  coadminUid: string;
  totalDeposits: number;
  totalCashouts: number;
  totalTransfers: number;
  totalBonusClaimed: number;
  transferCount24h: number;
  transferCount7d: number;
  transferCount30d: number;
  cashoutCount24h: number;
  cashoutCount7d: number;
  cashoutCount30d: number;
  activity24h: FinancialActivityWindow;
  activity7d: FinancialActivityWindow;
  depositToCashoutRatio: number;
  bonusToDepositRatio: number;
  cycleCount: number;
  riskScore: number;
  riskLevel: RiskLevel;
  alerts: string[];
  reviewedAt?: Timestamp | null;
  reviewedByUid?: string | null;
  reviewedByUsername?: string | null;
  bonusBlockedUntil?: Timestamp | null;
  transferBlockedUntil?: Timestamp | null;
  lastActivityAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
};

type ActorIdentity = {
  uid: string;
  username: string;
  role: string;
  coadminUid: string;
};

const TRANSFER_COOLDOWN_MS = 2 * 60 * 1000;
const AUTO_APPROVE_DAILY_TRANSFER_COUNT = 0;
const FAST_CASHOUT_WINDOW_MS = 60 * 60 * 1000;
const BONUS_AFTER_TRANSFER_WINDOW_MS = 24 * 60 * 60 * 1000;
const LOW_DEPOSIT_WITHDRAWAL_RATIO = 1.4;
const TEMP_BLOCK_DURATION_MS = 12 * 60 * 60 * 1000;

function toMs(value?: Timestamp | null) {
  return value?.toMillis?.() || 0;
}

function getStartMs(windowMs: number) {
  return Date.now() - windowMs;
}

function getDayStartMs() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function mapTransferRequest(docId: string, value: Omit<TransferRequest, 'id'>): TransferRequest {
  return { id: docId, ...value };
}

async function getCurrentActorIdentity() {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const userData = userSnap.data() as {
    username?: string;
    role?: string;
    coadminUid?: string | null;
    createdBy?: string | null;
  };
  const role = String(userData.role || '').toLowerCase();
  const coadminUid =
    role === 'coadmin'
      ? currentUser.uid
      : String(userData.coadminUid || userData.createdBy || '').trim();

  return {
    uid: currentUser.uid,
    username: userData.username?.trim() || 'User',
    role,
    coadminUid,
  } satisfies ActorIdentity;
}

async function createRiskAction(values: {
  playerUid: string;
  playerUsername?: string;
  coadminUid?: string;
  action: string;
  details?: string;
}) {
  let actor: ActorIdentity | null = null;
  try {
    actor = await getCurrentActorIdentity();
  } catch {
    actor = null;
  }

  await addDoc(collection(db, 'riskActions'), {
    playerUid: values.playerUid,
    playerUsername: values.playerUsername || 'Player',
    coadminUid: values.coadminUid || actor?.coadminUid || null,
    action: values.action,
    details: values.details || null,
    actorUid: actor?.uid || null,
    actorUsername: actor?.username || 'System',
    actorRole: actor?.role || 'system',
    createdAt: serverTimestamp(),
  });
}

function countByTypeWithin(events: FinancialEvent[], type: FinancialEventType, windowMs: number) {
  const startMs = getStartMs(windowMs);
  return events.filter((event) => event.type === type && toMs(event.createdAt) >= startMs).length;
}

function activityWindow(events: FinancialEvent[], windowMs: number): FinancialActivityWindow {
  const startMs = getStartMs(windowMs);
  const scoped = events.filter((event) => toMs(event.createdAt) >= startMs);
  return {
    cashouts: scoped.filter((event) => event.type === 'cashout').length,
    transfers: scoped.filter((event) => event.type === 'transfer').length,
    bonus: scoped.filter((event) => event.type === 'bonus').length,
    deposits: scoped.filter((event) => event.type === 'deposit' || event.type === 'recharge').length,
  };
}

function calculateCycleCount(events: FinancialEvent[]) {
  const sorted = [...events].sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt));
  let phase = 0;
  let cycles = 0;

  sorted.forEach((event) => {
    if (phase === 0 && event.type === 'cashout') {
      phase = 1;
      return;
    }
    if (phase === 1 && event.type === 'transfer') {
      phase = 2;
      return;
    }
    if (phase === 2 && event.type === 'bonus') {
      phase = 3;
      return;
    }
    if (phase === 3 && event.type === 'cashout') {
      cycles += 1;
      phase = 1;
      return;
    }
    if (event.type === 'cashout') {
      phase = 1;
    }
  });

  return cycles;
}

function hasBonusAfterTransfer(events: FinancialEvent[]) {
  const transfers = events.filter((event) => event.type === 'transfer');
  const bonuses = events.filter((event) => event.type === 'bonus');
  return transfers.some((transfer) => {
    const transferMs = toMs(transfer.createdAt);
    return bonuses.some((bonus) => {
      const bonusMs = toMs(bonus.createdAt);
      return bonusMs >= transferMs && bonusMs - transferMs <= BONUS_AFTER_TRANSFER_WINDOW_MS;
    });
  });
}

function hasFastCashoutAfterBonus(events: FinancialEvent[]) {
  const bonuses = events.filter((event) => event.type === 'bonus');
  const cashouts = events.filter((event) => event.type === 'cashout');
  return bonuses.some((bonus) => {
    const bonusMs = toMs(bonus.createdAt);
    return cashouts.some((cashout) => {
      const cashoutMs = toMs(cashout.createdAt);
      return cashoutMs >= bonusMs && cashoutMs - bonusMs <= FAST_CASHOUT_WINDOW_MS;
    });
  });
}

async function loadPlayerEvents(playerUid: string) {
  const snapshot = await getDocs(query(collection(db, 'financialEvents'), where('playerUid', '==', playerUid)));
  return snapshot.docs.map((docSnap) => docSnap.data() as FinancialEvent);
}

async function loadHistoricalPlayerEvents(playerUid: string) {
  const [cashoutSnap, transferSnap, requestSnap] = await Promise.all([
    getDocs(
      query(
        collection(db, 'playerCashoutTasks'),
        where('playerUid', '==', playerUid),
        where('status', '==', 'completed')
      )
    ),
    getDocs(
      query(
        collection(db, 'transferRequests'),
        where('playerUid', '==', playerUid),
        where('status', '==', 'approved')
      )
    ),
    getDocs(
      query(
        collection(db, 'playerGameRequests'),
        where('playerUid', '==', playerUid),
        where('status', '==', 'completed')
      )
    ),
  ]);

  const cashoutRows: HistoricalSourceRow[] = cashoutSnap.docs.map((docSnap) => {
    const value = docSnap.data() as { amountNpr?: number; completedAt?: Timestamp | null };
    return {
      amountNpr: Number(value.amountNpr || 0),
      createdAt: value.completedAt || null,
      type: 'cashout',
    };
  });

  const transferRows: HistoricalSourceRow[] = transferSnap.docs.map((docSnap) => {
    const value = docSnap.data() as { amountNpr?: number; approvedAt?: Timestamp | null };
    return {
      amountNpr: Number(value.amountNpr || 0),
      createdAt: value.approvedAt || null,
      type: 'transfer',
    };
  });

  const requestRows: HistoricalSourceRow[] = requestSnap.docs.flatMap((docSnap) => {
    const value = docSnap.data() as {
      type?: string;
      amount?: number;
      completedAt?: Timestamp | null;
      bonusPercentage?: number;
      baseAmount?: number;
    };
    const rows: HistoricalSourceRow[] = [];
    const completedAt = value.completedAt || null;
    const amount = Number(value.amount || 0);

    if (value.type === 'recharge' && amount > 0) {
      rows.push({
        amountNpr: amount,
        createdAt: completedAt,
        type: 'deposit',
      });

      const baseAmount = Math.max(0, Number(value.baseAmount || 0));
      const bonusAmount = Math.max(0, amount - baseAmount);
      if (bonusAmount > 0 || Number(value.bonusPercentage || 0) > 0) {
        rows.push({
          amountNpr: bonusAmount,
          createdAt: completedAt,
          type: 'bonus',
        });
      }
    }

    if (value.type === 'redeem' && amount > 0) {
      rows.push({
        amountNpr: amount,
        createdAt: completedAt,
        type: 'redeem',
      });
    }

    return rows;
  });

  return [...cashoutRows, ...transferRows, ...requestRows];
}

function mergeFinancialEvents(primary: FinancialEvent[], historical: HistoricalSourceRow[]) {
  const merged: FinancialEvent[] = [...primary];
  const index = new Set(
    primary.map((event) => `${event.type}:${Math.round(Number(event.amountNpr || 0))}:${toMs(event.createdAt || null)}`)
  );

  historical.forEach((item) => {
    const key = `${item.type}:${Math.round(Number(item.amountNpr || 0))}:${toMs(item.createdAt || null)}`;
    if (index.has(key)) {
      return;
    }
    index.add(key);
    merged.push({
      playerUid: '',
      coadminUid: '',
      amountNpr: Number(item.amountNpr || 0),
      type: item.type,
      createdAt: item.createdAt || null,
    });
  });

  return merged;
}

export async function computeAndStorePlayerRiskSnapshot(playerUid: string) {
  const playerSnap = await getDoc(doc(db, 'users', playerUid));

  if (!playerSnap.exists()) {
    return;
  }

  const playerData = playerSnap.data() as {
    username?: string;
    coadminUid?: string | null;
    createdBy?: string | null;
    bonusBlockedUntil?: Timestamp | null;
    transferBlockedUntil?: Timestamp | null;
  };
  const coadminUid = String(playerData.coadminUid || playerData.createdBy || '').trim();
  const [financialEvents, historicalEvents] = await Promise.all([
    loadPlayerEvents(playerUid),
    loadHistoricalPlayerEvents(playerUid),
  ]);
  const events = mergeFinancialEvents(financialEvents, historicalEvents);

  const totalDeposits = events
    .filter((event) => event.type === 'deposit' || event.type === 'recharge')
    .reduce((sum, event) => sum + Number(event.amountNpr || 0), 0);
  const totalCashouts = events
    .filter((event) => event.type === 'cashout')
    .reduce((sum, event) => sum + Number(event.amountNpr || 0), 0);
  const totalTransfers = events
    .filter((event) => event.type === 'transfer')
    .reduce((sum, event) => sum + Number(event.amountNpr || 0), 0);
  const totalBonusClaimed = events
    .filter((event) => event.type === 'bonus')
    .reduce((sum, event) => sum + Number(event.amountNpr || 0), 0);

  const transferCount24h = countByTypeWithin(events, 'transfer', 24 * 60 * 60 * 1000);
  const transferCount7d = countByTypeWithin(events, 'transfer', 7 * 24 * 60 * 60 * 1000);
  const transferCount30d = countByTypeWithin(events, 'transfer', 30 * 24 * 60 * 60 * 1000);
  const cashoutCount24h = countByTypeWithin(events, 'cashout', 24 * 60 * 60 * 1000);
  const cashoutCount7d = countByTypeWithin(events, 'cashout', 7 * 24 * 60 * 60 * 1000);
  const cashoutCount30d = countByTypeWithin(events, 'cashout', 30 * 24 * 60 * 60 * 1000);

  const depositToCashoutRatio = Number((totalDeposits / Math.max(totalCashouts, 1)).toFixed(2));
  const bonusToDepositRatio = Number((totalBonusClaimed / Math.max(totalDeposits, 1)).toFixed(2));
  const cycleCount = calculateCycleCount(events);
  const bonusAfterTransfer = hasBonusAfterTransfer(events);
  const fastCashoutAfterBonus = hasFastCashoutAfterBonus(events);
  const lowDepositHighWithdrawal =
    (totalDeposits === 0 && totalCashouts > 0) ||
    (totalDeposits > 0 && totalCashouts > totalDeposits * LOW_DEPOSIT_WITHDRAWAL_RATIO);

  const alerts: string[] = [];
  let riskScore = 0;

  if (cashoutCount24h > 3) {
    riskScore += 2;
    alerts.push('High cashout frequency');
  }
  if (transferCount24h > 3) {
    riskScore += 2;
    alerts.push('High transfer frequency');
  }
  if (bonusAfterTransfer) {
    riskScore += 3;
    alerts.push('Bonus used after transfer');
  }
  if (fastCashoutAfterBonus) {
    riskScore += 3;
    alerts.push('Fast cashout after bonus');
  }
  if (lowDepositHighWithdrawal) {
    riskScore += 4;
    alerts.push('Low deposit, high withdrawal');
  }
  if (cycleCount > 0) {
    riskScore += 2;
    alerts.push('Repeated recycle pattern detected');
  }

  const riskLevel: RiskLevel = riskScore >= 8 ? 'high' : riskScore >= 4 ? 'medium' : 'low';
  const sortedEvents = [...events].sort((left, right) => toMs(right.createdAt) - toMs(left.createdAt));
  const lastActivityAt = sortedEvents[0]?.createdAt || null;

  await setDoc(
    doc(db, 'playerRiskSnapshots', playerUid),
    {
      playerUid,
      playerUsername: playerData.username?.trim() || 'Player',
      coadminUid,
      totalDeposits,
      totalCashouts,
      totalTransfers,
      totalBonusClaimed,
      transferCount24h,
      transferCount7d,
      transferCount30d,
      cashoutCount24h,
      cashoutCount7d,
      cashoutCount30d,
      activity24h: activityWindow(events, 24 * 60 * 60 * 1000),
      activity7d: activityWindow(events, 7 * 24 * 60 * 60 * 1000),
      depositToCashoutRatio,
      bonusToDepositRatio,
      cycleCount,
      riskScore,
      riskLevel,
      alerts,
      bonusBlockedUntil: playerData.bonusBlockedUntil || null,
      transferBlockedUntil: playerData.transferBlockedUntil || null,
      lastActivityAt,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function recordFinancialEvent(values: {
  playerUid: string;
  coadminUid: string;
  amountNpr: number;
  type: FinancialEventType;
}) {
  await addDoc(collection(db, 'financialEvents'), {
    playerUid: values.playerUid,
    coadminUid: values.coadminUid,
    amountNpr: Math.max(0, Number(values.amountNpr || 0)),
    type: values.type,
    createdAt: serverTimestamp(),
  });
}

export async function recordFinancialEventAndRefreshRisk(values: {
  playerUid: string;
  coadminUid: string;
  amountNpr: number;
  type: FinancialEventType;
}) {
  await recordFinancialEvent(values);
  await computeAndStorePlayerRiskSnapshot(values.playerUid);
}

export async function createCashToCoinTransferRequest(playerUid: string) {
  const actor = await getCurrentActorIdentity();

  if (actor.uid !== playerUid) {
    throw new Error('Only the active player can request transfer.');
  }

  const playerRef = doc(db, 'users', playerUid);
  const playerSnap = await getDoc(playerRef);

  if (!playerSnap.exists()) {
    throw new Error('Player profile not found.');
  }

  const playerData = playerSnap.data() as {
    role?: string;
    username?: string;
    cash?: number;
    transferBlockedUntil?: Timestamp | null;
    coadminUid?: string | null;
    createdBy?: string | null;
  };
  const role = String(playerData.role || '').toLowerCase();

  if (role !== 'player') {
    throw new Error('Only players can transfer cash to coin.');
  }

  const coadminUidForRequest = String(
    resolveCoadminUid({
      uid: playerUid,
      ...playerData,
    }) || ''
  ).trim();

  if (!coadminUidForRequest) {
    throw new Error(
      'This player is not linked to a co-admin account. Contact support to fix the profile.'
    );
  }

  const transferBlockedUntilMs = toMs(playerData.transferBlockedUntil || null);
  if (transferBlockedUntilMs > Date.now()) {
    throw new Error('Transfer is temporarily blocked. Contact staff.');
  }

  const cashAmount = Number(playerData.cash || 0);
  if (cashAmount <= 0) {
    throw new Error('No cash available to transfer.');
  }

  const pendingSnapshot = await getDocs(
    query(
      collection(db, 'transferRequests'),
      where('playerUid', '==', playerUid),
      where('status', '==', 'pending')
    )
  );
  const hasRecentPending = pendingSnapshot.docs.some((docSnap) => {
    const value = docSnap.data() as { requestedAt?: Timestamp | null };
    return toMs(value.requestedAt || null) >= Date.now() - TRANSFER_COOLDOWN_MS;
  });

  if (hasRecentPending) {
    throw new Error('Please wait before sending another transfer request.');
  }

  const todayStart = Timestamp.fromMillis(getDayStartMs());
  const approvedTodaySnapshot = await getDocs(
    query(
      collection(db, 'transferRequests'),
      where('playerUid', '==', playerUid),
      where('status', '==', 'approved'),
      where('requestedAt', '>=', todayStart)
    )
  );
  const approvedTodayCount = approvedTodaySnapshot.size;
  const shouldAutoApprove =
    AUTO_APPROVE_DAILY_TRANSFER_COUNT > 0 &&
    approvedTodayCount < AUTO_APPROVE_DAILY_TRANSFER_COUNT;

  const transferRef = await addDoc(collection(db, 'transferRequests'), {
    playerUid,
    playerUsername: playerData.username?.trim() || 'Player',
    coadminUid: coadminUidForRequest,
    amountNpr: cashAmount,
    cashBalanceSnapshot: cashAmount,
    status: 'pending',
    requestedByUid: actor.uid,
    requestedByUsername: actor.username,
    requestedAt: serverTimestamp(),
    approvedByUid: null,
    approvedByUsername: null,
    approvedAt: null,
    rejectedByUid: null,
    rejectedByUsername: null,
    rejectedAt: null,
    rejectionReason: null,
    reviewed: false,
    autoApproved: shouldAutoApprove,
    processedAt: null,
  });

  await createRiskAction({
    playerUid,
    playerUsername: playerData.username?.trim() || 'Player',
    coadminUid: coadminUidForRequest,
    action: 'transfer_request_created',
    details: `Requested NPR ${cashAmount} cash to coin`,
  });

  if (shouldAutoApprove) {
    await approveTransferRequest(transferRef.id);
    return {
      requestId: transferRef.id,
      status: 'approved' as const,
      message:
        'Most profit comes from cashouts. Repeated cash-to-coin transfers may reduce long-term gains. Use this mainly for gameplay retention.',
    };
  }

  return {
    requestId: transferRef.id,
    status: 'pending' as const,
    message: 'Request sent to staff for approval',
  };
}

export async function approveTransferRequest(requestId: string) {
  const actor = await getCurrentActorIdentity();
  const requestRef = doc(db, 'transferRequests', requestId);
  let playerUid = '';
  let coadminUid = '';
  let playerUsername = 'Player';

  await runTransaction(db, async (transaction) => {
    const requestSnap = await transaction.get(requestRef);

    if (!requestSnap.exists()) {
      throw new Error('Transfer request not found.');
    }

    const requestData = requestSnap.data() as Omit<TransferRequest, 'id'>;
    if (requestData.status !== 'pending') {
      throw new Error('Transfer request already processed.');
    }

    playerUid = requestData.playerUid;
    coadminUid = requestData.coadminUid || '';
    playerUsername = requestData.playerUsername || 'Player';

    const playerRef = doc(db, 'users', requestData.playerUid);
    const playerSnap = await transaction.get(playerRef);

    if (!playerSnap.exists()) {
      throw new Error('Player profile not found.');
    }

    const playerData = playerSnap.data() as { coin?: number; cash?: number };
    const cashNow = Number(playerData.cash || 0);
    const amountNpr = Math.max(0, Number(requestData.amountNpr || 0));

    if (cashNow < amountNpr || amountNpr <= 0) {
      throw new Error('Transfer request is no longer valid due to low cash balance.');
    }

    const eventRef = doc(collection(db, 'financialEvents'));
    transaction.update(playerRef, {
      coin: Number(playerData.coin || 0) + amountNpr,
      cash: cashNow - amountNpr,
    });
    transaction.update(requestRef, {
      status: 'approved',
      approvedByUid: actor.uid,
      approvedByUsername: actor.username,
      approvedAt: serverTimestamp(),
      rejectionReason: null,
      processedAt: serverTimestamp(),
    });
    transaction.set(eventRef, {
      playerUid: requestData.playerUid,
      coadminUid: requestData.coadminUid || '',
      amountNpr,
      type: 'transfer',
      createdAt: serverTimestamp(),
    });
  });

  await computeAndStorePlayerRiskSnapshot(playerUid);
  await createRiskAction({
    playerUid,
    coadminUid,
    playerUsername,
    action: 'transfer_request_approved',
    details:
      'Most profit comes from cashouts. Repeated cash-to-coin transfers may reduce long-term gains. Use this mainly for gameplay retention.',
  });
}

export async function rejectTransferRequest(requestId: string, reason?: string) {
  const actor = await getCurrentActorIdentity();
  const requestRef = doc(db, 'transferRequests', requestId);
  const requestSnap = await getDoc(requestRef);

  if (!requestSnap.exists()) {
    throw new Error('Transfer request not found.');
  }

  const requestData = requestSnap.data() as Omit<TransferRequest, 'id'>;

  if (requestData.status !== 'pending') {
    throw new Error('Transfer request already processed.');
  }

  await updateDoc(requestRef, {
    status: 'rejected',
    rejectedByUid: actor.uid,
    rejectedByUsername: actor.username,
    rejectedAt: serverTimestamp(),
    rejectionReason: reason || 'Transfer denied due to suspected misuse.',
    processedAt: serverTimestamp(),
  });

  await createRiskAction({
    playerUid: requestData.playerUid,
    playerUsername: requestData.playerUsername,
    coadminUid: requestData.coadminUid,
    action: 'transfer_request_rejected',
    details: reason || 'Transfer denied due to suspected misuse.',
  });
}

export function listenPendingTransferRequestsByCoadminOrGlobal(
  coadminUid: string,
  onChange: (requests: TransferRequest[]) => void,
  onError?: (error: Error) => void
) {
  const scopedQuery = coadminUid
    ? query(
        collection(db, 'transferRequests'),
        where('status', '==', 'pending'),
        where('coadminUid', '==', coadminUid)
      )
    : query(collection(db, 'transferRequests'), where('status', '==', 'pending'));

  return onSnapshot(
    scopedQuery,
    (snapshot) => {
      const requests = snapshot.docs
        .map((docSnap) => mapTransferRequest(docSnap.id, docSnap.data() as Omit<TransferRequest, 'id'>))
        .sort((left, right) => toMs(right.requestedAt || null) - toMs(left.requestedAt || null));
      onChange(requests);
    },
    (error) => onError?.(error as Error)
  );
}

export function listenTransferRequestsByPlayer(
  playerUid: string,
  onChange: (requests: TransferRequest[]) => void,
  onError?: (error: Error) => void
) {
  const transfersQuery = query(collection(db, 'transferRequests'), where('playerUid', '==', playerUid));

  return onSnapshot(
    transfersQuery,
    (snapshot) => {
      const requests = snapshot.docs
        .map((docSnap) => mapTransferRequest(docSnap.id, docSnap.data() as Omit<TransferRequest, 'id'>))
        .sort((left, right) => toMs(right.requestedAt || null) - toMs(left.requestedAt || null));
      onChange(requests);
    },
    (error) => onError?.(error as Error)
  );
}

export function listenPlayerRiskSnapshotsByCoadmin(
  coadminUid: string,
  onChange: (snapshots: PlayerRiskSnapshot[]) => void,
  onError?: (error: Error) => void
) {
  const riskQuery = coadminUid
    ? query(collection(db, 'playerRiskSnapshots'), where('coadminUid', '==', coadminUid))
    : collection(db, 'playerRiskSnapshots');

  return onSnapshot(
    riskQuery,
    (snapshot) => {
      const rows = snapshot.docs
        .map((docSnap) => docSnap.data() as PlayerRiskSnapshot)
        .sort((left, right) => (right.riskScore || 0) - (left.riskScore || 0));
      onChange(rows);
    },
    (error) => onError?.(error as Error)
  );
}

export async function getPlayerRiskSnapshot(playerUid: string) {
  await computeAndStorePlayerRiskSnapshot(playerUid);
  const snapshot = await getDoc(doc(db, 'playerRiskSnapshots', playerUid));
  return snapshot.exists() ? (snapshot.data() as PlayerRiskSnapshot) : null;
}

export async function markRiskReviewed(playerUid: string) {
  const actor = await getCurrentActorIdentity();
  const snapshotRef = doc(db, 'playerRiskSnapshots', playerUid);
  await setDoc(
    snapshotRef,
    {
      reviewedAt: serverTimestamp(),
      reviewedByUid: actor.uid,
      reviewedByUsername: actor.username,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  await createRiskAction({
    playerUid,
    action: 'risk_marked_reviewed',
    details: 'Marked player risk as reviewed.',
  });
}

export async function setPlayerBonusBlock(playerUid: string, shouldBlock: boolean) {
  const until = shouldBlock ? Timestamp.fromMillis(Date.now() + TEMP_BLOCK_DURATION_MS) : null;
  await setDoc(doc(db, 'users', playerUid), { bonusBlockedUntil: until }, { merge: true });
  await setDoc(doc(db, 'playerRiskSnapshots', playerUid), { bonusBlockedUntil: until }, { merge: true });

  await createRiskAction({
    playerUid,
    action: shouldBlock ? 'bonus_block_enabled' : 'bonus_block_cleared',
    details: shouldBlock
      ? 'Bonus temporarily blocked due to risk review.'
      : 'Bonus block cleared.',
  });
}

export async function setPlayerTransferBlock(playerUid: string, shouldBlock: boolean) {
  const until = shouldBlock ? Timestamp.fromMillis(Date.now() + TEMP_BLOCK_DURATION_MS) : null;
  await setDoc(doc(db, 'users', playerUid), { transferBlockedUntil: until }, { merge: true });
  await setDoc(doc(db, 'playerRiskSnapshots', playerUid), { transferBlockedUntil: until }, { merge: true });

  await createRiskAction({
    playerUid,
    action: shouldBlock ? 'transfer_block_enabled' : 'transfer_block_cleared',
    details: shouldBlock
      ? 'Transfer temporarily blocked due to risk review.'
      : 'Transfer block cleared.',
  });
}

export async function flagPlayerRisk(values: { playerUid: string; reason: string; playerUsername?: string }) {
  const actor = await getCurrentActorIdentity();
  await createRiskAction({
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    coadminUid: actor.coadminUid,
    action: 'player_flagged',
    details: values.reason,
  });
}

export async function sendRiskAlertToStaff(values: {
  playerUid: string;
  playerUsername: string;
  reason: string;
  coadminUid: string;
}) {
  const actor = await getCurrentActorIdentity();
  await addDoc(collection(db, 'carerEscalationAlerts'), {
    coadminUid: values.coadminUid,
    contextType: 'cashbox_inquiry',
    taskId: null,
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    gameName: null,
    message: values.reason,
    createdByCarerUid: actor.uid,
    createdByCarerUsername: actor.username,
    createdAt: serverTimestamp(),
  });

  await createRiskAction({
    playerUid: values.playerUid,
    playerUsername: values.playerUsername,
    coadminUid: values.coadminUid,
    action: 'risk_alert_sent_to_staff',
    details: values.reason,
  });
}

export function getTransferCooldownMs() {
  return TRANSFER_COOLDOWN_MS;
}

export function getRiskRuleConfig() {
  return {
    fastCashoutWindowMs: FAST_CASHOUT_WINDOW_MS,
    bonusAfterTransferWindowMs: BONUS_AFTER_TRANSFER_WINDOW_MS,
    lowDepositWithdrawalRatio: LOW_DEPOSIT_WITHDRAWAL_RATIO,
    autoApproveDailyTransferCount: AUTO_APPROVE_DAILY_TRANSFER_COUNT,
  };
}
