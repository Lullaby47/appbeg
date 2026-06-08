import 'server-only';

import { adminDb } from '@/lib/firebase/admin';
import {
  getLockedPromoCoins,
  isReferralRechargeEligible,
  REFERRAL_REWARD_COINS,
} from '@/lib/economy/policy';
import { readCompletedRechargeRequestsForPlayer } from '@/lib/sql/playerGameRequestsCache';
import { readPlayersCacheByReferrerUid } from '@/lib/sql/playersCache';
import { getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { getReferralRewardClaimCacheById } from '@/lib/sql/referralRewardClaimsCache';
import {
  createPlayerRouteReadTrace,
  recordFirestoreRead,
  recordSqlRead,
  type PlayerRouteReadTrace,
} from '@/lib/server/playerRouteTiming';

export type ReferralRewardGroup = {
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

export function buildReferralClaimDocId(referrerUid: string, referredPlayerUid: string) {
  return `${referrerUid}__${referredPlayerUid}`;
}

async function loadQualifiedRechargeForReferredPlayerFromFirestore(
  referredPlayerUid: string,
  trace: PlayerRouteReadTrace
): Promise<RechargeLite | null> {
  const startedAt = Date.now();
  const rechargesSnap = await adminDb
    .collection('playerGameRequests')
    .where('playerUid', '==', referredPlayerUid)
    .where('type', '==', 'recharge')
    .where('status', '==', 'completed')
    .get();
  recordFirestoreRead(trace, {
    collection: 'playerGameRequests',
    path: `playerGameRequests?playerUid=${referredPlayerUid}&type=recharge&status=completed`,
    kind: 'query',
    durationMs: Date.now() - startedAt,
    docCount: rechargesSnap.size,
  });

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

async function loadQualifiedRechargeForReferredPlayer(
  referredPlayerUid: string,
  trace: PlayerRouteReadTrace
): Promise<RechargeLite | null> {
  const sqlStartedAt = Date.now();
  const cachedRecharges = await readCompletedRechargeRequestsForPlayer(referredPlayerUid);
  if (cachedRecharges !== null) {
    recordSqlRead(trace, {
      table: 'player_game_requests_cache',
      operation: 'completed_recharges_by_player',
      durationMs: Date.now() - sqlStartedAt,
      rowCount: cachedRecharges.length,
    });
    const eligible = cachedRecharges
      .filter(
        (recharge) =>
          recharge.amount > 0 &&
          isReferralRechargeEligible({
            bonusEventId: recharge.bonusEventId,
            bonusPercentage: recharge.bonusPercentage,
          })
      )
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
    if (eligible.length > 0) {
      const first = eligible[0];
      return {
        id: first.firebaseId,
        amount: first.amount,
        createdAtMs: first.createdAtMs,
        bonusEventId: first.bonusEventId,
        bonusPercentage: first.bonusPercentage,
      };
    }
    return null;
  }

  return loadQualifiedRechargeForReferredPlayerFromFirestore(referredPlayerUid, trace);
}

async function readClaimStatus(
  referrerUid: string,
  referredPlayerUid: string,
  trace: PlayerRouteReadTrace
): Promise<boolean> {
  const claimId = buildReferralClaimDocId(referrerUid, referredPlayerUid);
  const sqlStartedAt = Date.now();
  const cachedClaim = await getReferralRewardClaimCacheById(claimId);
  const sqlDurationMs = Date.now() - sqlStartedAt;
  const postgresAvailable = Boolean(getPlayerMirrorPool());

  if (postgresAvailable) {
    recordSqlRead(trace, {
      table: 'referral_reward_claims_cache',
      operation: cachedClaim ? 'get_by_id' : 'get_by_id_miss',
      durationMs: sqlDurationMs,
      rowCount: cachedClaim ? 1 : 0,
    });
    if (!cachedClaim) {
      return false;
    }
    return String(cachedClaim.status || '').toLowerCase() === 'claimed';
  }

  const startedAt = Date.now();
  const claimSnap = await adminDb.collection('referralRewardClaims').doc(claimId).get();
  recordFirestoreRead(trace, {
    collection: 'referralRewardClaims',
    path: `referralRewardClaims/${claimId}`,
    kind: 'get',
    durationMs: Date.now() - startedAt,
    docCount: claimSnap.exists ? 1 : 0,
  });
  return (
    claimSnap.exists &&
    String((claimSnap.data() as { status?: string }).status || '').toLowerCase() === 'claimed'
  );
}

async function loadReferredPlayersFromFirestore(referrerUid: string, trace: PlayerRouteReadTrace) {
  const startedAt = Date.now();
  const referredSnap = await adminDb
    .collection('users')
    .where('role', '==', 'player')
    .where('referredByUid', '==', referrerUid)
    .get();
  recordFirestoreRead(trace, {
    collection: 'users',
    path: `users?role=player&referredByUid=${referrerUid}`,
    kind: 'query',
    durationMs: Date.now() - startedAt,
    docCount: referredSnap.size,
  });
  return referredSnap.docs.map((referredDoc) => ({
    uid: referredDoc.id,
    username: String((referredDoc.data() as { username?: string }).username || '').trim(),
  }));
}

export async function loadReferralRewardGroups(referrerUid: string) {
  const trace = createPlayerRouteReadTrace();
  const sqlStartedAt = Date.now();
  const cachedPlayers = await readPlayersCacheByReferrerUid(referrerUid);

  let referredPlayers: Array<{ uid: string; username: string }>;
  if (cachedPlayers !== null) {
    recordSqlRead(trace, {
      table: 'players_cache',
      operation: 'referred_players_by_referrer',
      durationMs: Date.now() - sqlStartedAt,
      rowCount: cachedPlayers.length,
    });
    referredPlayers = cachedPlayers;
  } else {
    referredPlayers = await loadReferredPlayersFromFirestore(referrerUid, trace);
  }

  if (!referredPlayers.length) {
    return { groups: [] as ReferralRewardGroup[], trace };
  }

  const groups = await Promise.all(
    referredPlayers.map(async (referredPlayer) => {
      const referredPlayerUid = referredPlayer.uid;
      const referredPlayerName =
        String(referredPlayer.username || '').trim() || 'Unnamed Player';

      const [alreadyClaimed, qualifiedRecharge] = await Promise.all([
        readClaimStatus(referrerUid, referredPlayerUid, trace),
        loadQualifiedRechargeForReferredPlayer(referredPlayerUid, trace),
      ]);

      const isPending = Boolean(qualifiedRecharge) && !alreadyClaimed;

      return {
        referredPlayerUid,
        referredPlayerName,
        pendingRewardCoins: isPending ? REFERRAL_REWARD_COINS : 0,
        hasClaimableReward: isPending,
      } satisfies ReferralRewardGroup;
    })
  );

  return {
    groups: groups.filter((group) => group.pendingRewardCoins > 0),
    trace,
  };
}

/** Exported for POST claim route (Firestore authority for writes). */
export async function loadQualifiedRechargeForReferredPlayerFirestoreOnly(
  referredPlayerUid: string
) {
  const trace = createPlayerRouteReadTrace();
  const recharge = await loadQualifiedRechargeForReferredPlayerFromFirestore(
    referredPlayerUid,
    trace
  );
  return { recharge, trace };
}
