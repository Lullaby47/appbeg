import 'server-only';

import type { PoolClient } from 'pg';

import {
  getCashToCoinFee,
  getCoinToCashTip,
  parsePositiveInteger,
  parseTransferId,
} from '@/lib/server/playerTransferRules';
import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';
import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  readAuthorityOperationPayload,
} from '@/lib/sql/authorityLedger';
import {
  insertLiveOutboxEventWithClient,
  playerTransferLiveChannel,
} from '@/lib/sql/liveOutbox';

export type TransferDirection = 'cash_to_coin' | 'coin_to_cash';

export type AuthorityTransferResult = {
  success: true;
  duplicate: boolean;
  cash: number;
  coin: number;
  transferAmount: number;
  feeAmount: number;
  tipAmount: number;
  coinsReceived?: number;
  cashReceived?: number;
  transferId: string;
  eventId: string;
};

function resolveEventId(direction: TransferDirection, playerUid: string, transferId: string) {
  const prefix = direction === 'cash_to_coin' ? 'cashToCoin' : 'coinToCash';
  return `${prefix}_${playerUid}_${transferId}`;
}

function resolveOperationKey(
  playerUid: string,
  direction: TransferDirection,
  idempotencyKey: string
) {
  return `transfer:${playerUid}:${direction}:${idempotencyKey}`;
}

function resolveFinancialEventType(direction: TransferDirection) {
  return direction === 'cash_to_coin' ? 'cash_to_coin_transfer' : 'coin_to_cash_transfer';
}

function readTransferBlockedUntilMs(row: Record<string, unknown>) {
  const direct = toIsoString(row.transfer_blocked_until);
  if (direct) {
    const ms = new Date(direct).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  const raw = row.raw_firestore_data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const blocked = (raw as Record<string, unknown>).transferBlockedUntil;
    const iso = toIsoString(blocked);
    if (iso) {
      const ms = new Date(iso).getTime();
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return 0;
}

function storedTransferResult(
  payload: Record<string, unknown>,
  transferId: string,
  eventId: string
): AuthorityTransferResult {
  return {
    success: true,
    duplicate: true,
    cash: Math.max(0, Math.floor(Number(payload.cash || 0))),
    coin: Math.max(0, Math.floor(Number(payload.coin || 0))),
    transferAmount: Math.max(0, Number(payload.transferAmount || 0)),
    feeAmount: Number(payload.feeAmount || 0),
    tipAmount: Number(payload.tipAmount || 0),
    coinsReceived:
      payload.coinsReceived == null ? undefined : Number(payload.coinsReceived),
    cashReceived: payload.cashReceived == null ? undefined : Number(payload.cashReceived),
    transferId,
    eventId,
  };
}

async function writeTransferOutbox(
  client: PoolClient,
  input: {
    playerUid: string;
    transferId: string;
    direction: TransferDirection;
    status: string;
    transferAmount: number;
    cash: number;
    coin: number;
    updatedAt: string;
  }
) {
  await insertLiveOutboxEventWithClient(client, {
    channel: playerTransferLiveChannel(input.playerUid),
    eventType: input.direction === 'cash_to_coin' ? 'cash_to_coin_transfer' : 'coin_to_cash_transfer',
    entityType: 'player_transfer',
    entityId: input.transferId,
    source: 'authority_transfer',
    mirroredAt: input.updatedAt,
    payload: {
      entityId: input.transferId,
      playerUid: input.playerUid,
      transferId: input.transferId,
      direction: input.direction,
      status: input.status,
      transferAmount: input.transferAmount,
      cash: input.cash,
      coin: input.coin,
      updatedAt: input.updatedAt,
      source: 'authority',
    },
  });
}

async function insertTransferFinancialEvent(
  client: PoolClient,
  input: {
    eventId: string;
    playerUid: string;
    coadminUid: string | null;
    direction: TransferDirection;
    transferAmount: number;
    feeAmount: number;
    tipAmount: number;
    coinsReceived?: number;
    cashReceived?: number;
    transferId: string;
    beforeCash: number;
    afterCash: number;
    beforeCoin: number;
    afterCoin: number;
    nowIso: string;
  }
) {
  const type = resolveFinancialEventType(input.direction);
  const rawEvent = {
    playerUid: input.playerUid,
    playerId: input.playerUid,
    coadminUid: input.coadminUid,
    transferAmount: input.transferAmount,
    amountNpr: input.direction === 'cash_to_coin' ? input.transferAmount : undefined,
    amountCoins: input.direction === 'coin_to_cash' ? input.transferAmount : undefined,
    feeAmount: input.feeAmount,
    tipAmount: input.tipAmount,
    tipNpr: input.tipAmount,
    coinsReceived: input.coinsReceived ?? null,
    cashReceived: input.cashReceived ?? null,
    beforeCash: input.beforeCash,
    afterCash: input.afterCash,
    beforeCoins: input.beforeCoin,
    afterCoins: input.afterCoin,
    beforeCoin: input.beforeCoin,
    afterCoin: input.afterCoin,
    beforeBalances: { cash: input.beforeCash, coin: input.beforeCoin },
    afterBalances: { cash: input.afterCash, coin: input.afterCoin },
    transferId: input.transferId,
    type,
    timestamp: input.nowIso,
    createdAt: input.nowIso,
  };

  await client.query(
    `
      INSERT INTO public.financial_events_cache (
        firebase_id, player_uid, player_id, coadmin_uid, type,
        amount_npr, amount_coins, transfer_id,
        fee_amount, tip_amount, cash_received, coins_received,
        before_cash, after_cash, before_coin, after_coin,
        before_balances, after_balances,
        created_at, updated_at, source, mirrored_at, deleted_at,
        raw_firestore_data
      )
      VALUES (
        $1, $2, $2, NULLIF($3, ''), $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16::jsonb, $17::jsonb,
        $18::timestamptz, $18::timestamptz, 'authority_transfer', now(), NULL,
        $19::jsonb
      )
      ON CONFLICT (firebase_id) DO NOTHING
    `,
    [
      input.eventId,
      input.playerUid,
      input.coadminUid,
      type,
      input.direction === 'cash_to_coin' ? input.transferAmount : null,
      input.direction === 'coin_to_cash' ? input.transferAmount : null,
      input.transferId,
      input.feeAmount,
      input.tipAmount,
      input.cashReceived ?? null,
      input.coinsReceived ?? null,
      input.beforeCash,
      input.afterCash,
      input.beforeCoin,
      input.afterCoin,
      JSON.stringify({ cash: input.beforeCash, coin: input.beforeCoin }),
      JSON.stringify({ cash: input.afterCash, coin: input.afterCoin }),
      input.nowIso,
      JSON.stringify(rawEvent),
    ]
  );
}

async function insertTransferLedgerEvents(
  client: PoolClient,
  input: {
    eventId: string;
    playerUid: string;
    username: string | null;
    coadminUid: string | null;
    direction: TransferDirection;
    beforeCash: number;
    afterCash: number;
    beforeCoin: number;
    afterCoin: number;
    nowIso: string;
    rawEvent: Record<string, unknown>;
  }
) {
  const cashDelta = input.afterCash - input.beforeCash;
  const coinDelta = input.afterCoin - input.beforeCoin;
  const cashEventType =
    input.direction === 'cash_to_coin' ? 'cash_to_coin_cash_debit' : 'coin_to_cash_cash_credit';
  const coinEventType =
    input.direction === 'cash_to_coin' ? 'cash_to_coin_coin_credit' : 'coin_to_cash_coin_debit';

  await insertAuthorityLedgerEvent(client, {
    eventKey: `financialEvents:${input.eventId}:${input.playerUid}:cash:${cashEventType}`,
    userUid: input.playerUid,
    username: input.username,
    role: 'player',
    coadminUid: input.coadminUid,
    balanceType: 'cash',
    direction: cashDelta >= 0 ? 'credit' : 'debit',
    delta: cashDelta,
    absoluteAfter: input.afterCash,
    eventType: cashEventType,
    sourceCollection: 'financialEvents',
    sourceId: input.eventId,
    actorUid: input.playerUid,
    actorRole: 'player',
    confidence: 'high',
    sourceCreatedAt: input.nowIso,
    rawSourceData: input.rawEvent,
    sourceFields: {
      beforeCash: input.beforeCash,
      afterCash: input.afterCash,
    },
  });

  await insertAuthorityLedgerEvent(client, {
    eventKey: `financialEvents:${input.eventId}:${input.playerUid}:coin:${coinEventType}`,
    userUid: input.playerUid,
    username: input.username,
    role: 'player',
    coadminUid: input.coadminUid,
    balanceType: 'coin',
    direction: coinDelta >= 0 ? 'credit' : 'debit',
    delta: coinDelta,
    absoluteAfter: input.afterCoin,
    eventType: coinEventType,
    sourceCollection: 'financialEvents',
    sourceId: input.eventId,
    actorUid: input.playerUid,
    actorRole: 'player',
    confidence: 'high',
    sourceCreatedAt: input.nowIso,
    rawSourceData: input.rawEvent,
    sourceFields: {
      beforeCoin: input.beforeCoin,
      afterCoin: input.afterCoin,
    },
  });
}

export async function transferPlayerBalancesInSql(input: {
  playerUid: string;
  direction: TransferDirection;
  amountNpr?: unknown;
  amountCoins?: unknown;
  transferId?: unknown;
  idempotencyKey?: string | null;
}): Promise<AuthorityTransferResult> {
  const playerUid = cleanText(input.playerUid);
  const direction = input.direction;
  const transferId = parseTransferId(input.transferId);
  const idempotencyKey =
    cleanText(input.idempotencyKey) || cleanText(input.transferId) || transferId;

  if (!playerUid) {
    throw new Error('Player profile not found.');
  }
  if (!transferId || !idempotencyKey) {
    throw new Error('Transfer id is required.');
  }

  const amount =
    direction === 'cash_to_coin'
      ? parsePositiveInteger(input.amountNpr)
      : parsePositiveInteger(input.amountCoins);

  if (!amount) {
    throw new Error('Amount must be a positive whole number.');
  }
  if (direction === 'coin_to_cash' && amount < 10) {
    throw new Error('Minimum Coin to Cash amount is 10.');
  }

  const feeAmount =
    direction === 'cash_to_coin' ? getCashToCoinFee(amount) : getCoinToCashTip(amount);
  const tipAmount = direction === 'coin_to_cash' ? feeAmount : 0;
  const coinsReceived = direction === 'cash_to_coin' ? amount - feeAmount : undefined;
  const cashReceived = direction === 'coin_to_cash' ? amount - tipAmount : undefined;

  if (direction === 'cash_to_coin' && (coinsReceived ?? 0) <= 0) {
    throw new Error('Transfer amount is too low after fee.');
  }
  if (direction === 'coin_to_cash' && (cashReceived ?? 0) <= 0) {
    throw new Error('Transfer amount is too low after tip.');
  }

  const eventId = resolveEventId(direction, playerUid, transferId);
  const operationKey = resolveOperationKey(playerUid, direction, idempotencyKey);
  const operationType =
    direction === 'cash_to_coin' ? 'transfer_cash_to_coin' : 'transfer_coin_to_cash';

  const existingPayload = await readAuthorityOperationPayload(operationKey);
  if (existingPayload?.transferId) {
    return storedTransferResult(existingPayload, transferId, eventId);
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const client = await db.connect();
  const nowIso = new Date().toISOString();

  try {
    await client.query('BEGIN');

    const existingFinancial = await client.query(
      `
        SELECT firebase_id
        FROM public.financial_events_cache
        WHERE firebase_id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [eventId]
    );
    if ((existingFinancial.rowCount || 0) > 0) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      if (payload?.transferId) {
        return storedTransferResult(payload, transferId, eventId);
      }
      throw new Error('Duplicate transfer id.');
    }

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType,
      userUid: playerUid,
      sourceId: eventId,
      actorUid: playerUid,
      actorRole: 'player',
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      if (payload?.transferId) {
        return storedTransferResult(payload, transferId, eventId);
      }
      throw new Error('Duplicate transfer id.');
    }

    const playerLock = await client.query(
      `
        SELECT
          uid,
          username,
          role,
          status,
          coin,
          cash,
          coadmin_uid,
          created_by,
          raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerLock.rows.length) {
      throw new Error('Player profile not found.');
    }
    const player = playerLock.rows[0] as Record<string, unknown>;

    if (cleanText(player.role).toLowerCase() !== 'player') {
      throw new Error(
        direction === 'cash_to_coin'
          ? 'Only players can transfer cash to coin.'
          : 'Only players can transfer coin to cash.'
      );
    }
    if (cleanText(player.status).toLowerCase() === 'disabled') {
      throw new Error('Your account is blocked.');
    }

    const snapshotLock = await client.query(
      `
        SELECT transfer_blocked_until, raw_firestore_data
        FROM public.user_balance_snapshots_cache
        WHERE firebase_id = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    const snapshot = (snapshotLock.rows[0] as Record<string, unknown> | undefined) || {};
    const blockedUntilMs = readTransferBlockedUntilMs(snapshot);
    if (blockedUntilMs > Date.now()) {
      throw new Error('Transfer is temporarily blocked. Contact staff.');
    }

    const currentCash = Math.max(0, Math.floor(Number(player.cash || 0)));
    const currentCoin = Math.max(0, Math.floor(Number(player.coin || 0)));

    if (direction === 'cash_to_coin') {
      if (currentCash < amount) {
        throw new Error('Not enough cash available for transfer.');
      }
    } else if (currentCoin < amount) {
      throw new Error('Not enough coin available for transfer.');
    }

    const coadminUid =
      cleanText(player.coadmin_uid) || cleanText(player.created_by) || null;

    const newCash =
      direction === 'cash_to_coin' ? currentCash - amount : currentCash + (cashReceived ?? 0);
    const newCoin =
      direction === 'cash_to_coin' ? currentCoin + (coinsReceived ?? 0) : currentCoin - amount;

    await client.query(
      `
        UPDATE public.players_cache
        SET
          cash = $2,
          coin = $3,
          updated_at = $4::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
            || jsonb_build_object('cash', $2, 'coin', $3)
        WHERE uid = $1
          AND deleted_at IS NULL
      `,
      [playerUid, newCash, newCoin, nowIso]
    );

    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          cash = $2,
          coin = $3,
          updated_at = $4::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb)
            || jsonb_build_object('cash', $2, 'coin', $3)
        WHERE firebase_id = $1
          AND deleted_at IS NULL
      `,
      [playerUid, newCash, newCoin, nowIso]
    );

    const rawEvent = {
      playerUid,
      playerId: playerUid,
      coadminUid,
      transferAmount: amount,
      amountNpr: direction === 'cash_to_coin' ? amount : undefined,
      amountCoins: direction === 'coin_to_cash' ? amount : undefined,
      feeAmount,
      tipAmount,
      tipNpr: tipAmount,
      coinsReceived: coinsReceived ?? null,
      cashReceived: cashReceived ?? null,
      beforeCash: currentCash,
      afterCash: newCash,
      beforeCoins: currentCoin,
      afterCoins: newCoin,
      beforeCoin: currentCoin,
      afterCoin: newCoin,
      beforeBalances: { cash: currentCash, coin: currentCoin },
      afterBalances: { cash: newCash, coin: newCoin },
      transferId,
      type: resolveFinancialEventType(direction),
      timestamp: nowIso,
      createdAt: nowIso,
    };

    await insertTransferFinancialEvent(client, {
      eventId,
      playerUid,
      coadminUid,
      direction,
      transferAmount: amount,
      feeAmount,
      tipAmount,
      coinsReceived,
      cashReceived,
      transferId,
      beforeCash: currentCash,
      afterCash: newCash,
      beforeCoin: currentCoin,
      afterCoin: newCoin,
      nowIso,
    });

    await insertTransferLedgerEvents(client, {
      eventId,
      playerUid,
      username: cleanText(player.username) || null,
      coadminUid,
      direction,
      beforeCash: currentCash,
      afterCash: newCash,
      beforeCoin: currentCoin,
      afterCoin: newCoin,
      nowIso,
      rawEvent,
    });

    await writeTransferOutbox(client, {
      playerUid,
      transferId,
      direction,
      status: 'completed',
      transferAmount: amount,
      cash: newCash,
      coin: newCoin,
      updatedAt: nowIso,
    });

    const resultPayload = {
      cash: newCash,
      coin: newCoin,
      transferAmount: amount,
      feeAmount,
      tipAmount,
      coinsReceived: coinsReceived ?? null,
      cashReceived: cashReceived ?? null,
      transferId,
      eventId,
    };

    await client.query(
      `
        UPDATE public.authority_operations
        SET payload = $2::jsonb
        WHERE operation_key = $1
      `,
      [operationKey, JSON.stringify(resultPayload)]
    );

    await client.query('COMMIT');

    return {
      success: true,
      duplicate: false,
      cash: newCash,
      coin: newCoin,
      transferAmount: amount,
      feeAmount,
      tipAmount,
      coinsReceived,
      cashReceived,
      transferId,
      eventId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function transferCashToCoinInSql(input: {
  playerUid: string;
  amountNpr?: unknown;
  transferId?: unknown;
  idempotencyKey?: string | null;
}) {
  return transferPlayerBalancesInSql({
    playerUid: input.playerUid,
    direction: 'cash_to_coin',
    amountNpr: input.amountNpr,
    transferId: input.transferId,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function transferCoinToCashInSql(input: {
  playerUid: string;
  amountCoins?: unknown;
  transferId?: unknown;
  idempotencyKey?: string | null;
}) {
  return transferPlayerBalancesInSql({
    playerUid: input.playerUid,
    direction: 'coin_to_cash',
    amountCoins: input.amountCoins,
    transferId: input.transferId,
    idempotencyKey: input.idempotencyKey,
  });
}
