import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

type RewardGroup = {
  referredPlayerUid: string;
  referredPlayerName: string;
  pendingRewardCoins: number;
  hasClaimableReward: boolean;
};

function getNumber(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function isEligibleRecharge(values: {
  bonusEventId?: string | null;
  bonusPercentage?: number | null;
}) {
  const hasBonusEvent = Boolean(String(values.bonusEventId || '').trim());
  if (!hasBonusEvent) {
    return { eligible: true, ineligibleReason: null as string | null };
  }

  const bonusPercentage = getNumber(values.bonusPercentage);
  if (bonusPercentage <= 10) {
    return { eligible: true, ineligibleReason: null as string | null };
  }

  return {
    eligible: false,
    ineligibleReason: 'Bonus event above 10% is not eligible for referral reward.',
  };
}

function buildClaimDocId(referrerUid: string, rechargeId: string) {
  return `${referrerUid}__${rechargeId}`;
}

function buildCarryDocId(referrerUid: string, referredPlayerUid: string) {
  return `${referrerUid}__${referredPlayerUid}`;
}

type RechargeLite = {
  id: string;
  amount: number;
  bonusEventId: string;
  bonusPercentage: number | null;
  createdAtMs: number;
};

function toMs(value: unknown) {
  if (!value || typeof value !== 'object') {
    return 0;
  }
  const maybe = value as { toMillis?: () => number; toDate?: () => Date; seconds?: number };
  if (typeof maybe.toMillis === 'function') {
    return maybe.toMillis();
  }
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().getTime();
  }
  if (typeof maybe.seconds === 'number') {
    return maybe.seconds * 1000;
  }
  return 0;
}

function computeRewardByRechargeId(recharges: RechargeLite[]) {
  const eligible = recharges
    .filter((recharge) =>
      isEligibleRecharge({
        bonusEventId: recharge.bonusEventId,
        bonusPercentage: recharge.bonusPercentage,
      }).eligible
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);

  const rewardById = new Map<string, number>();
  eligible.forEach((recharge, index) => {
    if (index === 0) {
      rewardById.set(recharge.id, 5);
      return;
    }
    rewardById.set(recharge.id, Math.max(0, Number((recharge.amount * 0.01).toFixed(4))));
  });
  return rewardById;
}

async function verifyPlayerFromAuthHeader(request: Request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  const idToken = match?.[1];
  if (!idToken) {
    throw new Error('Missing or invalid authorization.');
  }

  const decoded = await adminAuth.verifyIdToken(idToken);
  const referrerUid = decoded.uid;
  const referrerRef = adminDb.collection('users').doc(referrerUid);
  const referrerSnap = await referrerRef.get();
  if (!referrerSnap.exists) {
    throw new Error('Player profile not found.');
  }

  const referrerData = referrerSnap.data() as { role?: string };
  if (String(referrerData.role || '').toLowerCase() !== 'player') {
    throw new Error('Only players can access referral rewards.');
  }

  return { referrerUid, referrerRef };
}

async function loadRewardGroups(referrerUid: string): Promise<RewardGroup[]> {
  const referredSnap = await adminDb
    .collection('users')
    .where('role', '==', 'player')
    .where('referredByUid', '==', referrerUid)
    .get();

  if (referredSnap.empty) {
    return [];
  }

  const groups: RewardGroup[] = [];

  for (const referredDoc of referredSnap.docs) {
    const referredUid = referredDoc.id;
    const referredData = referredDoc.data() as { username?: string };
    const referredPlayerName = String(referredData.username || '').trim() || 'Unnamed Player';

    const rechargesSnap = await adminDb
      .collection('playerGameRequests')
      .where('playerUid', '==', referredUid)
      .where('type', '==', 'recharge')
      .where('status', '==', 'completed')
      .get();

    let pendingRewardCoins = 0;
    const recharges: RechargeLite[] = [];

    for (const rechargeDoc of rechargesSnap.docs) {
      const rechargeId = rechargeDoc.id;
      const rechargeData = rechargeDoc.data() as {
        amount?: number;
        bonusEventId?: string | null;
        bonusPercentage?: number | null;
      };

      const rechargeAmount = Math.max(0, getNumber(rechargeData.amount));
      const bonusEventId = String(rechargeData.bonusEventId || '').trim();
      const bonusPercentage = bonusEventId ? getNumber(rechargeData.bonusPercentage) : null;
      recharges.push({
        id: rechargeId,
        amount: rechargeAmount,
        bonusEventId,
        bonusPercentage,
        createdAtMs: toMs((rechargeDoc.data() as { createdAt?: unknown }).createdAt),
      });
    }

    const rewardById = computeRewardByRechargeId(recharges);

    for (const recharge of recharges) {
      const rechargeId = recharge.id;
      const rewardCoins = Math.max(0, Number(rewardById.get(rechargeId) || 0));
      const eligibility = isEligibleRecharge({
        bonusEventId: recharge.bonusEventId,
        bonusPercentage: recharge.bonusPercentage,
      });

      const claimDocRef = adminDb
        .collection('referralRewardClaims')
        .doc(buildClaimDocId(referrerUid, rechargeId));
      const claimDoc = await claimDocRef.get();
      const claimData = claimDoc.exists
        ? (claimDoc.data() as { status?: string })
        : null;
      const alreadyClaimed = String(claimData?.status || '').toLowerCase() === 'claimed';
      if (!eligibility.eligible || rewardCoins <= 0) {
        continue;
      }
      if (!alreadyClaimed) {
        pendingRewardCoins += rewardCoins;
      }
    }

    const carryRef = adminDb
      .collection('referralRewardCarry')
      .doc(buildCarryDocId(referrerUid, referredUid));
    const carrySnap = await carryRef.get();
    const carryData = carrySnap.exists
      ? (carrySnap.data() as { carryPoints?: number })
      : null;
    const carryPoints = Math.max(0, getNumber(carryData?.carryPoints));
    const totalPendingPoints = pendingRewardCoins + carryPoints;

    groups.push({
      referredPlayerUid: referredUid,
      referredPlayerName,
      pendingRewardCoins: Number(totalPendingPoints.toFixed(4)),
      hasClaimableReward: totalPendingPoints >= 1,
    });
  }

  return groups;
}

export async function GET(request: Request) {
  try {
    const { referrerUid } = await verifyPlayerFromAuthHeader(request);
    const groups = await loadRewardGroups(referrerUid);
    return NextResponse.json({ success: true, groups });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load referral rewards.' },
      { status: 400 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { referrerUid, referrerRef } = await verifyPlayerFromAuthHeader(request);
    const body = (await request.json()) as { referredPlayerUid?: string };
    const referredPlayerUid = String(body.referredPlayerUid || '').trim();
    if (!referredPlayerUid) {
      return NextResponse.json({ error: 'Referred player uid is required.' }, { status: 400 });
    }

    let rewardCoins = 0;

    await adminDb.runTransaction(async (transaction) => {
      const [referrerSnap, referredSnap] = await Promise.all([
        transaction.get(referrerRef),
        transaction.get(adminDb.collection('users').doc(referredPlayerUid)),
      ]);

      if (!referrerSnap.exists) {
        throw new Error('Referrer profile not found.');
      }

      if (!referredSnap.exists) {
        throw new Error('Referred player profile not found.');
      }

      const referredData = referredSnap.data() as { referredByUid?: string | null };
      if (String(referredData.referredByUid || '').trim() !== referrerUid) {
        throw new Error('This player is not in your referral list.');
      }

      const rechargeQuery = adminDb
        .collection('playerGameRequests')
        .where('playerUid', '==', referredPlayerUid)
        .where('type', '==', 'recharge')
        .where('status', '==', 'completed');
      const rechargeSnap = await transaction.get(rechargeQuery);

      if (rechargeSnap.empty) {
        throw new Error('No rewards available.');
      }

      const recharges: RechargeLite[] = rechargeSnap.docs.map((docSnap) => {
        const data = docSnap.data() as {
          amount?: number;
          bonusEventId?: string | null;
          bonusPercentage?: number | null;
          createdAt?: unknown;
        };
        return {
          id: docSnap.id,
          amount: Math.max(0, getNumber(data.amount)),
          bonusEventId: String(data.bonusEventId || '').trim(),
          bonusPercentage: data.bonusEventId ? getNumber(data.bonusPercentage) : null,
          createdAtMs: toMs(data.createdAt),
        };
      });

      const rewardById = computeRewardByRechargeId(recharges);
      const claimRefs = recharges.map((recharge) =>
        adminDb.collection('referralRewardClaims').doc(buildClaimDocId(referrerUid, recharge.id))
      );
      const claimSnaps = await Promise.all(claimRefs.map((claimRef) => transaction.get(claimRef)));
      const claimedRechargeIds = new Set(
        claimSnaps
          .filter((claimSnap) => claimSnap.exists)
          .map((claimSnap) =>
            String((claimSnap.data() as { rechargeId?: string }).rechargeId || '')
          )
          .filter(Boolean)
      );

      const pendingRecharges = recharges.filter((recharge) => {
        const reward = Math.max(0, Number(rewardById.get(recharge.id) || 0));
        return reward > 0 && !claimedRechargeIds.has(recharge.id);
      });

      const pendingPoints = pendingRecharges.reduce(
        (sum, recharge) => sum + Math.max(0, Number(rewardById.get(recharge.id) || 0)),
        0
      );
      const carryRef = adminDb
        .collection('referralRewardCarry')
        .doc(buildCarryDocId(referrerUid, referredPlayerUid));
      const carrySnap = await transaction.get(carryRef);
      const carryData = carrySnap.exists
        ? (carrySnap.data() as { carryPoints?: number })
        : null;
      const carryPoints = Math.max(0, getNumber(carryData?.carryPoints));

      const totalPoints = pendingPoints + carryPoints;
      rewardCoins = Math.floor(totalPoints);
      const nextCarryPoints = Number((totalPoints - rewardCoins).toFixed(4));

      if (rewardCoins <= 0) {
        throw new Error(
          `You have ${Number(totalPoints.toFixed(4))} points. Need at least 1.0 points to claim 1 coin.`
        );
      }

      const referrerData = referrerSnap.data() as { coin?: number };
      const nextCoin = Math.max(0, getNumber(referrerData.coin)) + rewardCoins;
      transaction.update(referrerRef, { coin: nextCoin });

      for (const recharge of pendingRecharges) {
        const rewardAmount = Math.max(0, Number(rewardById.get(recharge.id) || 0));
        const claimRef = adminDb
          .collection('referralRewardClaims')
          .doc(buildClaimDocId(referrerUid, recharge.id));
        transaction.set(claimRef, {
          referrerUid,
          referredPlayerUid,
          rechargeId: recharge.id,
          rechargeAmount: recharge.amount,
          rewardAmount,
          status: 'claimed',
          claimedAt: FieldValue.serverTimestamp(),
        });
      }

      transaction.set(
        carryRef,
        {
          referrerUid,
          referredPlayerUid,
          carryPoints: nextCarryPoints,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return NextResponse.json({
      success: true,
      rewardCoins,
      referredPlayerUid,
      message:
        "Congratulations! You received referral reward coins from this player's recharge.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to claim referral reward.' },
      { status: 400 }
    );
  }
}
