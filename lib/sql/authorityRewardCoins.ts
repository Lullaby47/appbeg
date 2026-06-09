import 'server-only';

import { randomUUID } from 'crypto';

import { getTransferableCoinBalance } from '@/lib/economy/policy';
import {
  computeRewardCoinsAfterFee,
  REWARD_TRANSFER_FEE_PERCENT,
} from '@/lib/rewardCoinTransferFee';
import { updatePlayerBalancesInTxn } from '@/lib/sql/authorityGameRequestHelpers';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  readAuthorityOperationPayload,
} from '@/lib/sql/authorityLedger';
import {
  insertLiveOutboxEventWithClient,
  playerTransferLiveChannel,
} from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

const MAX_REWARD_COINS_PER_TRANSFER = 50;

function canonicalPlayerCoadminUid(player: {
  coadmin_uid?: unknown;
  created_by?: unknown;
  raw_firestore_data?: unknown;
}) {
  const raw = (player.raw_firestore_data as Record<string, unknown>) || {};
  return (
    cleanText(player.coadmin_uid) ||
    cleanText(player.created_by) ||
    cleanText(raw.coadminUid) ||
    cleanText(raw.createdBy) ||
    null
  );
}

function parsePositiveWhole(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

export async function rewardCoinsInSql(input: {
  senderUid: string;
  targetUid: string;
  amountCoins: number;
}) {
  const senderUid = cleanText(input.senderUid);
  const targetUid = cleanText(input.targetUid);
  const amountCoins = parsePositiveWhole(input.amountCoins);

  if (!senderUid || !targetUid) throw new Error('targetUid is required.');
  if (targetUid === senderUid) throw new Error('You cannot reward yourself.');
  if (amountCoins <= 0) throw new Error('Reward amount must be at least 1 coin.');
  if (amountCoins > MAX_REWARD_COINS_PER_TRANSFER) {
    throw new Error(`Maximum reward per transfer is ${MAX_REWARD_COINS_PER_TRANSFER} coins.`);
  }

  const { feeCoins, recipientCoins } = computeRewardCoinsAfterFee(amountCoins);
  if (recipientCoins < 1) {
    throw new Error('Reward amount is too low after the transfer fee.');
  }

  const rewardId = randomUUID();
  const operationKey = `reward_coins:${rewardId}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.rewardId) {
    return {
      success: true as const,
      duplicate: true,
      rewardId: String(existing.rewardId),
      amountCoins: Number(existing.amountCoins || amountCoins),
      feeCoins: Number(existing.feeCoins || feeCoins),
      recipientCoins: Number(existing.recipientCoins || recipientCoins),
    };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'reward_coins',
      userUid: senderUid,
      sourceId: rewardId,
      actorUid: senderUid,
      actorRole: 'player',
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      if (payload?.rewardId) {
        return {
          success: true as const,
          duplicate: true,
          rewardId: String(payload.rewardId),
          amountCoins: Number(payload.amountCoins || amountCoins),
          feeCoins: Number(payload.feeCoins || feeCoins),
          recipientCoins: Number(payload.recipientCoins || recipientCoins),
        };
      }
      throw new Error('Duplicate reward coins operation.');
    }

    const senderLock = await client.query(
      `
        SELECT uid, username, role, coin, promo_locked_coins, coadmin_uid, created_by, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [senderUid]
    );
    if (!senderLock.rows.length) throw new Error('Sender profile not found.');
    const sender = senderLock.rows[0] as Record<string, unknown>;
    if (cleanText(sender.role).toLowerCase() !== 'player') {
      throw new Error('Only players can reward coins.');
    }

    const targetLock = await client.query(
      `
        SELECT uid, username, role, coin, coadmin_uid, created_by, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [targetUid]
    );
    if (!targetLock.rows.length) throw new Error('Target player not found.');
    const target = targetLock.rows[0] as Record<string, unknown>;
    if (cleanText(target.role).toLowerCase() !== 'player') {
      throw new Error('Target user must be a player.');
    }

    const senderCoadminUid = canonicalPlayerCoadminUid(sender);
    const targetCoadminUid = canonicalPlayerCoadminUid(target);
    if (!senderCoadminUid || !targetCoadminUid || senderCoadminUid !== targetCoadminUid) {
      throw new Error('Forbidden: reward coins can only be sent within the same coadmin scope.');
    }

    const senderCoin = Math.max(0, parsePositiveWhole(sender.coin));
    const transferable = getTransferableCoinBalance(sender.coin, sender.promo_locked_coins);
    if (senderCoin < amountCoins || transferable < amountCoins) {
      throw new Error('Not enough transferable coin balance to reward.');
    }

    const targetCoin = Math.max(0, parsePositiveWhole(target.coin));
    const newSenderCoin = senderCoin - amountCoins;
    const newTargetCoin = targetCoin + recipientCoins;

    await updatePlayerBalancesInTxn(client, senderUid, { coin: newSenderCoin });
    await updatePlayerBalancesInTxn(client, targetUid, { coin: newTargetCoin });

    const rewardRaw = {
      fromUid: senderUid,
      fromUsername: cleanText(sender.username) || 'Player',
      toUid: targetUid,
      toUsername: cleanText(target.username) || 'Player',
      amountCoins,
      feeCoins,
      receivedCoins: recipientCoins,
      feePercent: REWARD_TRANSFER_FEE_PERCENT,
      coadminUid: senderCoadminUid,
      createdAt: nowIso,
    };

    await client.query(
      `
        INSERT INTO public.player_coin_rewards_cache (
          firebase_id, from_uid, from_username, to_uid, to_username,
          coadmin_uid, amount_coins, fee_coins, received_coins, fee_percent,
          created_at, source, mirrored_at, deleted_at, raw_firestore_data
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11::timestamptz, 'authority_reward_coins', now(), NULL, $12::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        rewardId,
        senderUid,
        rewardRaw.fromUsername,
        targetUid,
        rewardRaw.toUsername,
        senderCoadminUid,
        amountCoins,
        feeCoins,
        recipientCoins,
        REWARD_TRANSFER_FEE_PERCENT,
        nowIso,
        JSON.stringify(rewardRaw),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `playerCoinRewards:${rewardId}:${senderUid}:coin:reward_coins_debit`,
      userUid: senderUid,
      username: rewardRaw.fromUsername,
      role: 'player',
      coadminUid: senderCoadminUid,
      balanceType: 'coin',
      direction: 'debit',
      delta: -amountCoins,
      absoluteAfter: newSenderCoin,
      eventType: 'reward_coins_debit',
      sourceCollection: 'player_coin_rewards_cache',
      sourceId: rewardId,
      actorUid: senderUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: rewardRaw,
      sourceFields: { relatedPlayerUid: targetUid, feeCoins },
    });

    await insertAuthorityLedgerEvent(client, {
      eventKey: `playerCoinRewards:${rewardId}:${targetUid}:coin:reward_coins_credit`,
      userUid: targetUid,
      username: rewardRaw.toUsername,
      role: 'player',
      coadminUid: senderCoadminUid,
      balanceType: 'coin',
      direction: 'credit',
      delta: recipientCoins,
      absoluteAfter: newTargetCoin,
      eventType: 'reward_coins_credit',
      sourceCollection: 'player_coin_rewards_cache',
      sourceId: rewardId,
      actorUid: senderUid,
      actorRole: 'player',
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: rewardRaw,
      sourceFields: { relatedPlayerUid: senderUid, feeCoins },
    });

    for (const uid of [senderUid, targetUid]) {
      await insertLiveOutboxEventWithClient(client, {
        channel: playerTransferLiveChannel(uid),
        eventType: 'reward_coins',
        entityType: 'player_coin_reward',
        entityId: rewardId,
        source: 'authority_reward_coins',
        mirroredAt: nowIso,
        payload: {
          entityId: rewardId,
          rewardId,
          fromUid: senderUid,
          toUid: targetUid,
          amountCoins,
          feeCoins,
          recipientCoins,
          updatedAt: nowIso,
          source: 'authority',
        },
      });
    }

    const resultPayload = { rewardId, amountCoins, feeCoins, recipientCoins };
    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify(resultPayload)]
    );

    await client.query('COMMIT');
    return {
      success: true as const,
      duplicate: false,
      rewardId,
      amountCoins,
      feeCoins,
      recipientCoins,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
