import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import {
  getLockedPromoCoins,
  isReferralRechargeEligible,
  REFERRAL_REWARD_COINS,
} from '@/lib/economy/policy';

type RewardGroup = {
  referredPlayerUid: string;
  referredPlayerName: string;
  pendingRewardCoins: number;
  hasClaimableReward: boolean;
};

type RechargeLite = {
  id: string;
  amount: number;
  createdAtMs: number;
  bonusEventId: string;
  bonusPercentage: number | null;
};

function getNumber(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

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

function buildClaimDocId(referrerUid: string, referredPlayerUid: string) {
  return `${referrerUid}__${referredPlayerUid}`;
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

async function loadQualifiedRechargeForReferredPlayer(
  referredPlayerUid: string
): Promise<RechargeLite | null> {
  const rechargesSnap = await adminDb
    .collection('playerGameRequests')
    .where('playerUid', '==', referredPlayerUid)
    .where('type', '==', 'recharge')
    .where('status', '==', 'completed')
    .get();

  const recharges = rechargesSnap.docs
    .map((docSnap) => {
      const data = docSnap.data() as {
        amount?: number;
        createdAt?: unknown;
        completedAt?: unknown;
        bonusEventId?: string | null;
        bonusPercentage?: number | null;
      };

      return {
        id: docSnap.id,
        amount: Math.max(0, getNumber(data.amount)),
        createdAtMs: Math.max(toMs(data.completedAt), toMs(data.createdAt)),
        bonusEventId: String(data.bonusEventId || '').trim(),
        bonusPercentage: data.bonusEventId ? getNumber(data.bonusPercentage) : null,
      } satisfies RechargeLite;
    })
    .filter(
      (recharge) =>
        recharge.amount > 0 &&
        isReferralRechargeEligible({
          bonusEventId: recharge.bonusEventId,
          bonusPercentage: recharge.bonusPercentage,
        })
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);

  return recharges[0] || null;
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

  const groups = await Promise.all(
    referredSnap.docs.map(async (referredDoc) => {
      const referredPlayerUid = referredDoc.id;
      const referredData = referredDoc.data() as { username?: string };
      const referredPlayerName =
        String(referredData.username || '').trim() || 'Unnamed Player';

      const [claimSnap, qualifiedRecharge] = await Promise.all([
        adminDb
          .collection('referralRewardClaims')
          .doc(buildClaimDocId(referrerUid, referredPlayerUid))
          .get(),
        loadQualifiedRechargeForReferredPlayer(referredPlayerUid),
      ]);

      const alreadyClaimed =
        claimSnap.exists &&
        String((claimSnap.data() as { status?: string }).status || '').toLowerCase() ===
          'claimed';
      const isPending = Boolean(qualifiedRecharge) && !alreadyClaimed;

      return {
        referredPlayerUid,
        referredPlayerName,
        pendingRewardCoins: isPending ? REFERRAL_REWARD_COINS : 0,
        hasClaimableReward: isPending,
      } satisfies RewardGroup;
    })
  );

  return groups.filter((group) => group.pendingRewardCoins > 0);
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

    const qualifiedRecharge = await loadQualifiedRechargeForReferredPlayer(referredPlayerUid);
    if (!qualifiedRecharge) {
      return NextResponse.json({ error: 'No rewards available.' }, { status: 400 });
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

      const referredData = referredSnap.data() as {
        referredByUid?: string | null;
        username?: string;
      };
      if (String(referredData.referredByUid || '').trim() !== referrerUid) {
        throw new Error('This player is not in your referral list.');
      }

      const claimRef = adminDb
        .collection('referralRewardClaims')
        .doc(buildClaimDocId(referrerUid, referredPlayerUid));
      const claimSnap = await transaction.get(claimRef);
      if (
        claimSnap.exists &&
        String((claimSnap.data() as { status?: string }).status || '').toLowerCase() ===
          'claimed'
      ) {
        throw new Error('Reward already claimed.');
      }

      rewardCoins = REFERRAL_REWARD_COINS;
      const referrerData = referrerSnap.data() as {
        coin?: number;
        promoLockedCoins?: number;
      };

      transaction.update(referrerRef, {
        coin: Math.max(0, getNumber(referrerData.coin)) + rewardCoins,
        promoLockedCoins:
          getLockedPromoCoins(referrerData.promoLockedCoins) + rewardCoins,
        referralBonusNotice: 'Your referral completed their first recharge. Reward added.',
        referralBonusNoticeAt: FieldValue.serverTimestamp(),
      });

      transaction.update(referredSnap.ref, {
        referralRewardStatus: 'qualified',
        referralQualifiedAt: FieldValue.serverTimestamp(),
      });

      transaction.set(claimRef, {
        referrerUid,
        referredPlayerUid,
        referredPlayerName: String(referredData.username || '').trim() || 'Player',
        rechargeId: qualifiedRecharge.id,
        rechargeAmount: qualifiedRecharge.amount,
        rewardAmount: rewardCoins,
        status: 'claimed',
        qualifiedAt: FieldValue.serverTimestamp(),
        claimedAt: FieldValue.serverTimestamp(),
      });
    });

    return NextResponse.json({
      success: true,
      rewardCoins,
      referredPlayerUid,
      message: "Congratulations! You received referral reward coins from this player's recharge.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to claim referral reward.' },
      { status: 400 }
    );
  }
}
