import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import {
  apiUserAuthFirestoreMs,
  apiUserAuthSqlMs,
  requireApiUser,
} from '@/lib/firebase/apiAuth';
import {
  getLockedPromoCoins,
  isReferralRechargeEligible,
  REFERRAL_REWARD_COINS,
} from '@/lib/economy/policy';
import {
  buildReferralClaimDocId,
  loadReferralRewardGroups,
} from '@/lib/server/playerReferralRewardsRead';
import { logPlayerRouteTiming } from '@/lib/server/playerRouteTiming';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { claimReferralRewardInSql } from '@/lib/sql/authorityReferral';
import { mirrorReferralRewardClaimById } from '@/lib/sql/referralRewardClaimsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

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

async function verifyPlayerFromAuthHeader(request: Request) {
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) {
    const payload = (await auth.response.json().catch(() => ({}))) as { error?: string };
    const error = new Error(payload.error || 'Missing or invalid authorization.');
    (error as Error & { authTiming?: typeof auth.timing }).authTiming = auth.timing;
    throw error;
  }

  return {
    referrerUid: auth.user.uid,
    referrerRef: adminDb.collection('users').doc(auth.user.uid),
    authTiming: auth.timing,
  };
}

/** POST claim path: Firestore authority for eligibility + money writes. */
async function loadQualifiedRechargeForReferredPlayer(referredPlayerUid: string) {
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
      };
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

export async function GET(request: Request) {
  const startedAt = Date.now();
  let authMs = 0;
  let authSqlMs = 0;
  let authFirestoreMs = 0;

  try {
    const { referrerUid, authTiming } = await verifyPlayerFromAuthHeader(request);
    authMs = authTiming.auth_ms;
    authSqlMs = apiUserAuthSqlMs(authTiming);
    authFirestoreMs = apiUserAuthFirestoreMs(authTiming);

    const { groups, trace } = await loadReferralRewardGroups(referrerUid);
    const totalMs = Date.now() - startedAt;

    logPlayerRouteTiming('[PLAYER_REFERRAL_REWARDS]', {
      method: 'GET',
      ok: true,
      uid: referrerUid,
      groupCount: groups.length,
      auth_ms: authMs,
      sql_ms: authSqlMs + trace.sqlMs,
      firestore_ms: authFirestoreMs + trace.firestoreMs,
      total_ms: totalMs,
      trace,
    });
    return NextResponse.json({ success: true, groups });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load referral rewards.';
    const authTiming = (error as Error & { authTiming?: { auth_ms: number; sql_profile_ms: number; sql_session_ms: number; session_doc_ms: number; user_doc_ms: number } })
      .authTiming;
    if (authTiming) {
      authMs = authTiming.auth_ms;
      authSqlMs = authTiming.sql_profile_ms + authTiming.sql_session_ms;
      authFirestoreMs = authTiming.session_doc_ms + authTiming.user_doc_ms;
    }
    const totalMs = Date.now() - startedAt;
    logPlayerRouteTiming('[PLAYER_REFERRAL_REWARDS]', {
      method: 'GET',
      ok: false,
      error: message,
      auth_ms: authMs,
      sql_ms: authSqlMs,
      firestore_ms: authFirestoreMs,
      total_ms: totalMs,
    });
    return NextResponse.json(
      { error: message },
      { status: /authorization|token|logged out/i.test(message) ? 401 : 400 }
    );
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let authMs = 0;
  let authSqlMs = 0;
  let authFirestoreMs = 0;
  let firestoreMs = 0;

  try {
    const { referrerUid, referrerRef, authTiming } = await verifyPlayerFromAuthHeader(request);
    authMs = authTiming.auth_ms;
    authSqlMs = apiUserAuthSqlMs(authTiming);
    authFirestoreMs = apiUserAuthFirestoreMs(authTiming);

    const body = (await request.json()) as { referredPlayerUid?: string };
    const referredPlayerUid = String(body.referredPlayerUid || '').trim();
    if (!referredPlayerUid) {
      return NextResponse.json({ error: 'Referred player uid is required.' }, { status: 400 });
    }

    if (isAuthoritySqlWriteEnabled()) {
      const result = await claimReferralRewardInSql({
        referrerUid,
        referredPlayerUid,
      });
      logAuthoritySqlWrite('/api/player/referral-rewards', {
        referrerUid,
        referredPlayerUid,
        claimId: result.claimId,
        duplicate: result.duplicate,
        alreadyClaimed: result.alreadyClaimed,
      });
      const totalMs = Date.now() - startedAt;
      logPlayerRouteTiming('[PLAYER_REFERRAL_REWARDS]', {
        method: 'POST',
        ok: true,
        uid: referrerUid,
        referredPlayerUid,
        auth_ms: authMs,
        sql_ms: authSqlMs,
        firestore_ms: authFirestoreMs,
        total_ms: totalMs,
      });
      return NextResponse.json({
        success: true,
        rewardCoins: result.rewardCoins,
        referredPlayerUid: result.referredPlayerUid,
        message: result.message,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    const qualifiedRecharge = await loadQualifiedRechargeForReferredPlayer(referredPlayerUid);
    if (!qualifiedRecharge) {
      return NextResponse.json({ error: 'No rewards available.' }, { status: 400 });
    }

    let rewardCoins = 0;
    const claimId = buildReferralClaimDocId(referrerUid, referredPlayerUid);
    const transactionStartedAt = Date.now();

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

      const claimRef = adminDb.collection('referralRewardClaims').doc(claimId);
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

    firestoreMs = Date.now() - transactionStartedAt;

    void mirrorReferralRewardClaimById(claimId, 'appbeg_referral_reward_claim');
    void mirrorUserBalanceSnapshotById(referrerUid, 'appbeg_referral_reward_claim');
    void mirrorUserBalanceSnapshotById(referredPlayerUid, 'appbeg_referral_reward_claim');

    const totalMs = Date.now() - startedAt;
    logPlayerRouteTiming('[PLAYER_REFERRAL_REWARDS]', {
      method: 'POST',
      ok: true,
      uid: referrerUid,
      referredPlayerUid,
      auth_ms: authMs,
      sql_ms: authSqlMs,
      firestore_ms: authFirestoreMs + firestoreMs,
      total_ms: totalMs,
      firestore_reads: [
        {
          collection: 'playerGameRequests',
          path: `playerGameRequests?playerUid=${referredPlayerUid}&type=recharge&status=completed`,
          kind: 'query',
          source: 'firestore',
        },
        {
          collection: 'users|referralRewardClaims',
          path: 'runTransaction(users + referralRewardClaims)',
          kind: 'transaction',
          durationMs: firestoreMs,
          source: 'firestore',
        },
      ],
    });
    return NextResponse.json({
      success: true,
      rewardCoins,
      referredPlayerUid,
      message: "Congratulations! You received referral reward coins from this player's recharge.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to claim referral reward.';
    const totalMs = Date.now() - startedAt;
    logPlayerRouteTiming('[PLAYER_REFERRAL_REWARDS]', {
      method: 'POST',
      ok: false,
      error: message,
      auth_ms: authMs,
      sql_ms: authSqlMs,
      firestore_ms: authFirestoreMs + firestoreMs,
      total_ms: totalMs,
    });
    return NextResponse.json(
      { error: message },
      { status: /authorization|token|logged out/i.test(message) ? 401 : 400 }
    );
  }
}
