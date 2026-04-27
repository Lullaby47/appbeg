import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

type ClaimStatus = 'pending' | 'claimed' | 'ineligible';

type RewardRow = {
  rechargeId: string;
  rechargeAmount: number;
  rechargeTypeLabel: 'Normal recharge' | 'Bonus event recharge';
  bonusPercentage: number | null;
  rewardCoins: number;
  claimStatus: ClaimStatus;
  canClaim: boolean;
  claimedAt: string | null;
  ineligibleReason: string | null;
};

type RewardGroup = {
  referredPlayerUid: string;
  referredPlayerName: string;
  rows: RewardRow[];
  pendingRewardCoins: number;
  hasClaimableReward: boolean;
};

function getNumber(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function toIso(value: unknown) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const maybe = value as { toDate?: () => Date; toMillis?: () => number };
  if (typeof maybe.toDate === 'function') {
    return maybe.toDate().toISOString();
  }
  if (typeof maybe.toMillis === 'function') {
    return new Date(maybe.toMillis()).toISOString();
  }
  return null;
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

    const rows: RewardRow[] = [];
    let pendingRewardCoins = 0;

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
      const rewardCoins = Math.max(0, Math.floor(rechargeAmount * 0.01));
      const eligibility = isEligibleRecharge({
        bonusEventId,
        bonusPercentage,
      });

      const claimDocRef = adminDb
        .collection('referralRewardClaims')
        .doc(buildClaimDocId(referrerUid, rechargeId));
      const claimDoc = await claimDocRef.get();
      const claimData = claimDoc.exists
        ? (claimDoc.data() as { status?: string; claimedAt?: unknown })
        : null;
      const alreadyClaimed = String(claimData?.status || '').toLowerCase() === 'claimed';

      let claimStatus: ClaimStatus = 'pending';
      let canClaim = true;
      let ineligibleReason: string | null = null;

      if (!eligibility.eligible || rewardCoins <= 0) {
        claimStatus = 'ineligible';
        canClaim = false;
        ineligibleReason =
          eligibility.ineligibleReason ||
          (rewardCoins <= 0 ? 'Recharge amount is too low for 1% coin reward.' : null);
      } else if (alreadyClaimed) {
        claimStatus = 'claimed';
        canClaim = false;
      } else {
        pendingRewardCoins += rewardCoins;
      }

      rows.push({
        rechargeId,
        rechargeAmount,
        rechargeTypeLabel: bonusEventId ? 'Bonus event recharge' : 'Normal recharge',
        bonusPercentage,
        rewardCoins,
        claimStatus,
        canClaim,
        claimedAt: toIso(claimData?.claimedAt || null),
        ineligibleReason,
      });
    }

    rows.sort((a, b) => b.rechargeAmount - a.rechargeAmount);

    groups.push({
      referredPlayerUid: referredUid,
      referredPlayerName,
      rows,
      pendingRewardCoins,
      hasClaimableReward: rows.some((row) => row.canClaim),
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
    const body = (await request.json()) as { rechargeId?: string };
    const rechargeId = String(body.rechargeId || '').trim();
    if (!rechargeId) {
      return NextResponse.json({ error: 'Recharge id is required.' }, { status: 400 });
    }

    const rechargeRef = adminDb.collection('playerGameRequests').doc(rechargeId);
    const claimRef = adminDb
      .collection('referralRewardClaims')
      .doc(buildClaimDocId(referrerUid, rechargeId));

    let rewardCoins = 0;
    let referredPlayerUid = '';

    await adminDb.runTransaction(async (transaction) => {
      const [referrerSnap, rechargeSnap, claimSnap] = await Promise.all([
        transaction.get(referrerRef),
        transaction.get(rechargeRef),
        transaction.get(claimRef),
      ]);

      if (!referrerSnap.exists) {
        throw new Error('Referrer profile not found.');
      }

      if (!rechargeSnap.exists) {
        throw new Error('Recharge not found.');
      }

      if (claimSnap.exists) {
        const existing = claimSnap.data() as { status?: string };
        if (String(existing.status || '').toLowerCase() === 'claimed') {
          throw new Error('Reward already claimed for this recharge.');
        }
      }

      const rechargeData = rechargeSnap.data() as {
        playerUid?: string;
        type?: string;
        status?: string;
        amount?: number;
        bonusEventId?: string | null;
        bonusPercentage?: number | null;
      };
      const rechargeType = String(rechargeData.type || '').toLowerCase();
      const rechargeStatus = String(rechargeData.status || '').toLowerCase();
      if (rechargeType !== 'recharge' || rechargeStatus !== 'completed') {
        throw new Error('Only completed recharge records are eligible.');
      }

      referredPlayerUid = String(rechargeData.playerUid || '').trim();
      if (!referredPlayerUid) {
        throw new Error('Invalid recharge record.');
      }

      const referredRef = adminDb.collection('users').doc(referredPlayerUid);
      const referredSnap = await transaction.get(referredRef);
      if (!referredSnap.exists) {
        throw new Error('Referred player profile not found.');
      }

      const referredData = referredSnap.data() as { referredByUid?: string | null };
      if (String(referredData.referredByUid || '').trim() !== referrerUid) {
        throw new Error('This recharge does not belong to your referral list.');
      }

      const eligibility = isEligibleRecharge({
        bonusEventId: String(rechargeData.bonusEventId || '').trim(),
        bonusPercentage: getNumber(rechargeData.bonusPercentage),
      });
      if (!eligibility.eligible) {
        throw new Error(eligibility.ineligibleReason || 'Recharge is not eligible for reward.');
      }

      const rechargeAmount = Math.max(0, getNumber(rechargeData.amount));
      rewardCoins = Math.max(0, Math.floor(rechargeAmount * 0.01));
      if (rewardCoins <= 0) {
        throw new Error('Recharge amount is too low for referral reward.');
      }

      const referrerData = referrerSnap.data() as { coin?: number };
      const nextCoin = Math.max(0, getNumber(referrerData.coin)) + rewardCoins;
      transaction.update(referrerRef, { coin: nextCoin });

      transaction.set(claimRef, {
        referrerUid,
        referredPlayerUid,
        rechargeId,
        rechargeAmount,
        rewardAmount: rewardCoins,
        status: 'claimed',
        claimedAt: FieldValue.serverTimestamp(),
      });
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
