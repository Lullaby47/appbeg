import 'server-only';

import type { PoolClient } from 'pg';

import {
  getLockedPromoCoins,
  isReferralRechargeEligible,
  REFERRAL_REWARD_COINS,
} from '@/lib/economy/policy';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  readAuthorityOperationPayload,
} from '@/lib/sql/authorityLedger';
import {
  patchPlayerReferralFieldsInTxn,
  updatePlayerBalancesInTxn,
} from '@/lib/sql/authorityGameRequestHelpers';
import { insertLiveOutboxEventWithClient, playerFreeplayLiveChannel } from '@/lib/sql/liveOutbox';
import { readCompletedRechargeRequestsForPlayerWithClient } from '@/lib/sql/playerGameRequestsCache';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { buildReferralClaimDocId } from '@/lib/server/playerReferralRewardsRead';

export type AuthorityReferralClaimInput = {
  referrerUid: string;
  referredPlayerUid: string;
};

export type AuthorityReferralClaimResult = {
  success: true;
  duplicate: boolean;
  alreadyClaimed: boolean;
  rewardCoins: number;
  referredPlayerUid: string;
  claimId: string;
  message: string;
};

function readPlayerCoin(row: Record<string, unknown>) {
  const coin = Number(row.coin);
  if (Number.isFinite(coin)) return Math.max(0, coin);
  const raw = row.raw_firestore_data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fromRaw = Number((raw as Record<string, unknown>).coin || 0);
    return Number.isFinite(fromRaw) ? Math.max(0, fromRaw) : 0;
  }
  return 0;
}

function readPromoLockedCoins(row: Record<string, unknown>) {
  const direct = Number(row.promo_locked_coins);
  if (Number.isFinite(direct)) return Math.max(0, direct);
  return getLockedPromoCoins(
    row.raw_firestore_data &&
      typeof row.raw_firestore_data === 'object' &&
      !Array.isArray(row.raw_firestore_data)
      ? (row.raw_firestore_data as Record<string, unknown>).promoLockedCoins
      : 0
  );
}

async function loadQualifiedRechargeInTxn(client: PoolClient, referredPlayerUid: string) {
  const recharges = await readCompletedRechargeRequestsForPlayerWithClient(
    client,
    referredPlayerUid
  );
  const eligible = recharges
    .filter(
      (recharge) =>
        recharge.amount > 0 &&
        isReferralRechargeEligible({
          bonusEventId: recharge.bonusEventId,
          bonusPercentage: recharge.bonusPercentage,
        })
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
  return eligible[0] || null;
}

async function upsertReferralClaimInTxn(
  client: PoolClient,
  claimId: string,
  raw: Record<string, unknown>,
  source: string
) {
  const nowIso = String(raw.claimedAt || raw.qualifiedAt || new Date().toISOString());
  await client.query(
    `
      INSERT INTO public.referral_reward_claims_cache (
        firebase_id, referrer_uid, referred_player_uid, referred_player_name,
        recharge_id, recharge_amount, reward_amount, status,
        qualified_at, claimed_at, source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''),
        NULLIF($5, ''), $6, $7, NULLIF($8, ''),
        $9::timestamptz, $10::timestamptz, $11, now(), NULL, $12::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        referrer_uid = EXCLUDED.referrer_uid,
        referred_player_uid = EXCLUDED.referred_player_uid,
        referred_player_name = EXCLUDED.referred_player_name,
        recharge_id = EXCLUDED.recharge_id,
        recharge_amount = EXCLUDED.recharge_amount,
        reward_amount = EXCLUDED.reward_amount,
        status = EXCLUDED.status,
        qualified_at = EXCLUDED.qualified_at,
        claimed_at = EXCLUDED.claimed_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      claimId,
      cleanText(raw.referrerUid),
      cleanText(raw.referredPlayerUid),
      cleanText(raw.referredPlayerName),
      cleanText(raw.rechargeId),
      raw.rechargeAmount == null ? null : Number(raw.rechargeAmount),
      raw.rewardAmount == null ? null : Number(raw.rewardAmount),
      cleanText(raw.status),
      raw.qualifiedAt ? String(raw.qualifiedAt) : nowIso,
      raw.claimedAt ? String(raw.claimedAt) : nowIso,
      source,
      JSON.stringify(raw),
    ]
  );
}

export async function claimReferralRewardInSql(
  input: AuthorityReferralClaimInput
): Promise<AuthorityReferralClaimResult> {
  const referrerUid = cleanText(input.referrerUid);
  const referredPlayerUid = cleanText(input.referredPlayerUid);
  if (!referrerUid || !referredPlayerUid) {
    throw new Error('Referred player uid is required.');
  }

  const claimId = buildReferralClaimDocId(referrerUid, referredPlayerUid);
  const operationKey = `referral_reward:${referrerUid}:${claimId}`;

  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.claimId) {
    return {
      success: true,
      duplicate: true,
      alreadyClaimed: existing.alreadyClaimed === true,
      rewardCoins: Number(existing.rewardCoins || REFERRAL_REWARD_COINS),
      referredPlayerUid,
      claimId,
      message:
        'Congratulations! You received referral reward coins from this player\'s recharge.',
    };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const qualifiedRecharge = await loadQualifiedRechargeInTxn(client, referredPlayerUid);
    if (!qualifiedRecharge) {
      throw new Error('No rewards available.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'referral_reward',
      userUid: referrerUid,
      sourceId: claimId,
      actorUid: referrerUid,
      actorRole: 'player',
      payload: {},
    });
    if (!claim.claimed) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      if (payload?.claimId) {
        return {
          success: true,
          duplicate: true,
          alreadyClaimed: payload.alreadyClaimed === true,
          rewardCoins: Number(payload.rewardCoins || REFERRAL_REWARD_COINS),
          referredPlayerUid,
          claimId,
          message:
            'Congratulations! You received referral reward coins from this player\'s recharge.',
        };
      }
      throw new Error('Duplicate referral claim in progress.');
    }

    const claimResult = await client.query(
      `
        SELECT status
        FROM public.referral_reward_claims_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [claimId]
    );
    if (claimResult.rows.length) {
      const status = cleanText((claimResult.rows[0] as Record<string, unknown>).status).toLowerCase();
      if (status === 'claimed') {
        await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
          operationKey,
          JSON.stringify({
            claimId,
            alreadyClaimed: true,
            rewardCoins: REFERRAL_REWARD_COINS,
          }),
        ]);
        await client.query('COMMIT');
        return {
          success: true,
          duplicate: false,
          alreadyClaimed: true,
          rewardCoins: REFERRAL_REWARD_COINS,
          referredPlayerUid,
          claimId,
          message: 'Reward already claimed.',
        };
      }
    }

    const [referrerResult, referredResult] = await Promise.all([
      client.query(
        `
          SELECT uid, username, role, status, coin, promo_locked_coins, raw_firestore_data
          FROM public.players_cache
          WHERE uid = $1 AND deleted_at IS NULL
          FOR UPDATE
        `,
        [referrerUid]
      ),
      client.query(
        `
          SELECT uid, username, role, status, referred_by_uid, raw_firestore_data
          FROM public.players_cache
          WHERE uid = $1 AND deleted_at IS NULL
          FOR UPDATE
        `,
        [referredPlayerUid]
      ),
    ]);

    if (!referrerResult.rows.length) throw new Error('Referrer profile not found.');
    if (!referredResult.rows.length) throw new Error('Referred player profile not found.');

    const referrer = referrerResult.rows[0] as Record<string, unknown>;
    const referred = referredResult.rows[0] as Record<string, unknown>;
    if (cleanText(referrer.role).toLowerCase() !== 'player') {
      throw new Error('Referrer must be an active player.');
    }
    if (cleanText(referrer.status).toLowerCase() !== 'active') {
      throw new Error('Referrer player is inactive.');
    }
    if (cleanText(referred.role).toLowerCase() !== 'player') {
      throw new Error('Referred user must be an active player.');
    }
    if (cleanText(referred.status).toLowerCase() !== 'active') {
      throw new Error('Referred player is inactive.');
    }
    if (cleanText(referred.referred_by_uid) !== referrerUid) {
      throw new Error('This player is not in your referral list.');
    }

    const rewardCoins = REFERRAL_REWARD_COINS;
    const currentCoin = readPlayerCoin(referrer);
    const currentLocked = readPromoLockedCoins(referrer);
    const newCoin = currentCoin + rewardCoins;
    const newLocked = currentLocked + rewardCoins;
    const nowIso = new Date().toISOString();
    const referredPlayerName = cleanText(referred.username) || 'Player';

    await updatePlayerBalancesInTxn(client, referrerUid, {
      coin: newCoin,
      promoLockedCoins: newLocked,
      rawPatch: {
        referralBonusNotice:
          'Your referral completed their first recharge. Reward added.',
        referralBonusNoticeAt: nowIso,
      },
    });

    await patchPlayerReferralFieldsInTxn(client, referredPlayerUid, {
      referralRewardStatus: 'qualified',
      referralQualifiedAt: nowIso,
      rawPatch: {
        referralRewardStatus: 'qualified',
        referralQualifiedAt: nowIso,
      },
    });

    const claimRaw = {
      referrerUid,
      referredPlayerUid,
      referredPlayerName,
      rechargeId: qualifiedRecharge.firebaseId,
      rechargeAmount: qualifiedRecharge.amount,
      rewardAmount: rewardCoins,
      status: 'claimed',
      qualifiedAt: nowIso,
      claimedAt: nowIso,
    };
    await upsertReferralClaimInTxn(client, claimId, claimRaw, 'authority_referral_claim');

    await insertAuthorityLedgerEvent(client, {
      eventKey: `referralRewardClaims:${claimId}:${referrerUid}:coin:referral_reward_coin_credit`,
      userUid: referrerUid,
      username: cleanText(referrer.username) || 'Player',
      role: 'player',
      balanceType: 'coin',
      direction: 'credit',
      delta: rewardCoins,
      absoluteAfter: newCoin,
      eventType: 'referral_reward_coin_credit',
      sourceCollection: 'referral_reward_claims_cache',
      sourceId: claimId,
      actorUid: referrerUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: claimRaw,
      sourceFields: { rewardAmount: rewardCoins, referredPlayerUid },
    });
    await insertAuthorityLedgerEvent(client, {
      eventKey: `referralRewardClaims:${claimId}:${referrerUid}:promoLockedCoins:referral_reward_promo_locked_credit`,
      userUid: referrerUid,
      username: cleanText(referrer.username) || 'Player',
      role: 'player',
      balanceType: 'promoLockedCoins',
      direction: 'credit',
      delta: rewardCoins,
      absoluteAfter: newLocked,
      eventType: 'referral_reward_promo_locked_credit',
      sourceCollection: 'referral_reward_claims_cache',
      sourceId: claimId,
      actorUid: referrerUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: claimRaw,
      sourceFields: { rewardAmount: rewardCoins, referredPlayerUid },
    });

    await insertLiveOutboxEventWithClient(client, {
      channel: playerFreeplayLiveChannel(referrerUid),
      eventType: 'referral_reward_claimed',
      entityType: 'referral_reward_claim',
      entityId: claimId,
      source: 'authority_referral_claim',
      mirroredAt: nowIso,
      payload: {
        claimId,
        referrerUid,
        referredPlayerUid,
        rewardCoins,
        updatedAt: nowIso,
      },
    });
    await insertLiveOutboxEventWithClient(client, {
      channel: playerFreeplayLiveChannel(referrerUid),
      eventType: 'balance_update',
      entityType: 'player_balance',
      entityId: referrerUid,
      source: 'authority_referral_claim',
      mirroredAt: nowIso,
      payload: { playerUid: referrerUid, updatedAt: nowIso },
    });

    await client.query(`UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`, [
      operationKey,
      JSON.stringify({
        claimId,
        alreadyClaimed: false,
        rewardCoins,
      }),
    ]);
    await client.query('COMMIT');

    return {
      success: true,
      duplicate: false,
      alreadyClaimed: false,
      rewardCoins,
      referredPlayerUid,
      claimId,
      message:
        'Congratulations! You received referral reward coins from this player\'s recharge.',
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
