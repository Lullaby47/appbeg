import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  Timestamp,
} from 'firebase/firestore';

import { auth, db } from '@/lib/firebase/client';
import { getCurrentUserCoadminUid } from '@/lib/coadmin/scope';
import { recordFinancialEventAndRefreshRisk } from '@/features/risk/playerRisk';

export type BonusEvent = {
  id: string;
  coadminUid: string;
  bonusName: string;
  gameName: string;
  amountNpr: number;
  description: string;
  bonusPercentage: number;
  createdByUid: string;
  createdByUsername: string;
  createdByRole: 'staff' | 'coadmin';
  createdAt?: Timestamp | null;
};

function toBonusEvent(docId: string, value: Omit<BonusEvent, 'id'>): BonusEvent {
  return { id: docId, ...value };
}

function sortByNewest(list: BonusEvent[]) {
  return [...list].sort((left, right) => {
    const leftTime = left.createdAt?.toMillis?.() || 0;
    const rightTime = right.createdAt?.toMillis?.() || 0;
    return rightTime - leftTime;
  });
}

/** Newest bonus events shown on the player dashboard (up to 10). */
export const MAX_PLAYER_BONUS_EVENTS_DISPLAY = 10;

/**
 * All bonus events for the player’s coadmin (staff- or coadmin-created), newest first.
 * `listenBonusEventsByCoadmin` already scopes by coadmin — every player under that coadmin sees the same list.
 * Each doc is first-come-first-served: the first player to claim removes it (see `initiateBonusEventPlay`).
 */
export function getBonusEventsForPlayerDisplay(events: BonusEvent[]): BonusEvent[] {
  return sortByNewest(events).slice(0, MAX_PLAYER_BONUS_EVENTS_DISPLAY);
}

/** @deprecated Use {@link getBonusEventsForPlayerDisplay} — staff-only filter removed. */
export function getStaffBonusEventsForPlayerDisplay(events: BonusEvent[]) {
  return getBonusEventsForPlayerDisplay(events);
}

// Staff reward tuning thresholds.
const SAFE_BONUS_PERCENT = 8;
const MID_BONUS_PERCENT = 20;
const MAX_REWARDED_BONUS_PERCENT = 30;

function getStaffBonusMultiplier(bonusPercent: number) {
  if (bonusPercent <= SAFE_BONUS_PERCENT) return 1.0;
  if (bonusPercent <= MID_BONUS_PERCENT) return 0.5;
  if (bonusPercent <= MAX_REWARDED_BONUS_PERCENT) return 0.2;
  return 0;
}

export async function createBonusEvent(values: {
  bonusName: string;
  gameName: string;
  amountNpr: number;
  description: string;
  bonusPercentage: number;
}) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error('Not authenticated.');
  }

  const bonusName = values.bonusName.trim();
  const gameName = values.gameName.trim();
  const amountNpr = Math.round(Number(values.amountNpr || 0));
  const description = values.description.trim();
  const bonusPercentage = Math.round(Number(values.bonusPercentage || 0));

  if (!bonusName) {
    throw new Error('Bonus name is required.');
  }

  if (!description) {
    throw new Error('Description is required.');
  }

  if (!gameName) {
    throw new Error('Game name is required.');
  }

  if (amountNpr <= 0) {
    throw new Error('Amount must be greater than zero.');
  }

  if (bonusPercentage <= 0) {
    throw new Error('Bonus percentage must be greater than zero.');
  }

  if (bonusPercentage > 50) {
    throw new Error('Bonus percentage cannot be more than 50%.');
  }

  const userSnap = await getDoc(doc(db, 'users', currentUser.uid));

  if (!userSnap.exists()) {
    throw new Error('Current user profile not found.');
  }

  const userData = userSnap.data() as { username?: string; role?: string };
  const role = String(userData.role || '').toLowerCase();

  if (role !== 'staff' && role !== 'coadmin') {
    throw new Error('Only staff and coadmin can create bonus events.');
  }

  const coadminUid = await getCurrentUserCoadminUid();

  await addDoc(collection(db, 'bonusEvents'), {
    coadminUid,
    bonusName,
    gameName,
    amountNpr,
    description,
    bonusPercentage,
    createdByUid: currentUser.uid,
    createdByUsername: userData.username?.trim() || 'User',
    createdByRole: role,
    createdAt: serverTimestamp(),
  });
}

export function listenBonusEventsByCoadmin(
  coadminUid: string,
  onChange: (events: BonusEvent[]) => void,
  onError?: (error: Error) => void
) {
  const eventsQuery = query(collection(db, 'bonusEvents'), where('coadminUid', '==', coadminUid));

  return onSnapshot(
    eventsQuery,
    (snapshot) => {
      const events = snapshot.docs.map((docSnap) =>
        toBonusEvent(docSnap.id, docSnap.data() as Omit<BonusEvent, 'id'>)
      );
      onChange(sortByNewest(events));
    },
    (error) => onError?.(error as Error)
  );
}

export async function activateBonusEventForPlayer(values: {
  playerUid: string;
  bonusEvent: BonusEvent;
}) {
  const currentUser = auth.currentUser;

  if (!currentUser || currentUser.uid !== values.playerUid) {
    throw new Error('Not authenticated as current player.');
  }

  await updateDoc(doc(db, 'users', values.playerUid), {
    activeBonusEventId: values.bonusEvent.id,
    activeBonusStaffUid:
      values.bonusEvent.createdByRole === 'staff' ? values.bonusEvent.createdByUid : null,
    activeBonusEventName: values.bonusEvent.bonusName,
    activeBonusGameName: values.bonusEvent.gameName,
    activeBonusAmountNpr: values.bonusEvent.amountNpr,
    activeBonusPercentage: values.bonusEvent.bonusPercentage,
  });
}

export async function initiateBonusEventPlay(values: {
  playerUid: string;
  bonusEventId: string;
}) {
  const currentUser = auth.currentUser;

  if (!currentUser || currentUser.uid !== values.playerUid) {
    throw new Error('Not authenticated as current player.');
  }

  const playerRef = doc(db, 'users', values.playerUid);
  const bonusEventRef = doc(db, 'bonusEvents', values.bonusEventId);
  const requestRef = doc(collection(db, 'playerGameRequests'));
  let trackedCoadminUid = '';
  let trackedBonusAmount = 0;

  await runTransaction(db, async (transaction) => {
    const [playerSnap, bonusEventSnap] = await Promise.all([
      transaction.get(playerRef),
      transaction.get(bonusEventRef),
    ]);

    if (!playerSnap.exists()) {
      throw new Error('Player profile not found.');
    }

    if (!bonusEventSnap.exists()) {
      throw new Error(
        'This bonus was already claimed by another player or is no longer available.'
      );
    }

    const playerData = playerSnap.data() as {
      role?: string;
      coin?: number;
      bonusBlockedUntil?: Timestamp | null;
    };
    const bonusEvent = bonusEventSnap.data() as Omit<BonusEvent, 'id'>;

    if (String(playerData.role || '').toLowerCase() !== 'player') {
      throw new Error('Only players can start bonus event play.');
    }
    if ((playerData.bonusBlockedUntil?.toMillis?.() || 0) > Date.now()) {
      throw new Error('Bonus play is temporarily blocked for this account.');
    }

    const baseAmount = Number(bonusEvent.amountNpr || 0);
    const bonusPercent = Number(bonusEvent.bonusPercentage || 0);
    const bonusAddAmount =
      bonusPercent > 0
        ? Math.max(1, Math.round((baseAmount * bonusPercent) / 100))
        : 0;
    const boostedAmount = baseAmount + bonusAddAmount;
    trackedCoadminUid = bonusEvent.coadminUid;
    trackedBonusAmount = bonusAddAmount;
    const currentCoins = Number(playerData.coin || 0);

    if (baseAmount <= 0) {
      throw new Error('Bonus event amount is invalid.');
    }

    if (bonusPercent <= 0) {
      throw new Error('Bonus event percentage is invalid.');
    }

    if (bonusPercent > 50) {
      throw new Error('Bonus event percentage cannot be more than 50%.');
    }

    if (currentCoins < baseAmount) {
      throw new Error('Low coins: cannot initiate this bonus event.');
    }

    const staffRef =
      bonusEvent.createdByRole === 'staff' ? doc(db, 'users', bonusEvent.createdByUid) : null;
    const staffSnap = staffRef ? await transaction.get(staffRef) : null;
    const staffData = staffSnap?.exists()
      ? (staffSnap.data() as { cashBoxNpr?: number })
      : { cashBoxNpr: 0 };
    if (bonusEvent.createdByRole === 'staff') {
      // Higher amount => higher reward, but higher bonus% => lower reward.
      // This protects profitability while still rewarding retention-oriented bonuses.
      const normalizedAmount = Math.max(1, baseAmount) / 1000; // scales by amount
      const amountFactor = Math.min(3.5, 0.6 + Math.log10(normalizedAmount + 1) * 2.2);
      const percentPenalty = Math.max(0.25, 1.2 - bonusPercent / 60); // inverse bonus%
      const randomVariance = 0.9 + Math.random() * 0.3; // 0.9 - 1.2
      const rawReward = amountFactor * percentPenalty * randomVariance;
      const multiplier = getStaffBonusMultiplier(bonusPercent);
      const adjustedReward = rawReward * multiplier;
      const minReward = bonusPercent <= SAFE_BONUS_PERCENT ? 0.2 : 0;
      const randomAedReward =
        multiplier === 0
          ? 0
          : Number(Math.max(minReward, adjustedReward).toFixed(2));

      transaction.set(
        staffRef!,
        {
          cashBoxNpr: Number(staffData.cashBoxNpr || 0) + randomAedReward,
        },
        { merge: true }
      );
    }

    transaction.update(playerRef, {
      coin: currentCoins - baseAmount,
      activeBonusEventId: bonusEventSnap.id,
      activeBonusStaffUid:
        bonusEvent.createdByRole === 'staff' ? bonusEvent.createdByUid : null,
      activeBonusEventName: bonusEvent.bonusName,
      activeBonusGameName: bonusEvent.gameName,
      activeBonusAmountNpr: baseAmount,
      activeBonusPercentage: bonusPercent,
    });

    transaction.set(requestRef, {
      playerUid: values.playerUid,
      gameName: bonusEvent.gameName,
      amount: boostedAmount,
      baseAmount,
      bonusPercentage: bonusPercent,
      bonusEventId: bonusEventSnap.id,
      type: 'recharge',
      status: 'pending',
      createdBy: bonusEvent.coadminUid,
      coadminUid: bonusEvent.coadminUid,
      createdAt: serverTimestamp(),
      completedAt: null,
      pokedAt: null,
      pokeMessage: null,
      coinDeductedOnRequest: true,
    });

    transaction.delete(bonusEventRef);
  });

  if (trackedBonusAmount > 0) {
    await recordFinancialEventAndRefreshRisk({
      playerUid: values.playerUid,
      coadminUid: trackedCoadminUid,
      amountNpr: trackedBonusAmount,
      type: 'bonus',
    });
  }
}
