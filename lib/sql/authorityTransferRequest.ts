import 'server-only';

import { randomUUID } from 'crypto';

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

export async function approveTransferRequestInSql(input: {
  requestId: string;
  actorUid: string;
  actorUsername: string;
  actorRole: string;
  callerCoadminUid?: string | null;
  isAdmin: boolean;
}) {
  const requestId = cleanText(input.requestId);
  if (!requestId) throw new Error('requestId is required.');

  const operationKey = `transfer_request_approve:${requestId}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.approved) {
    return { success: true as const, duplicate: true, eventId: String(existing.eventId || '') };
  }

  const eventId = randomUUID();
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'transfer_request_approve',
      sourceId: requestId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      if (payload?.approved) {
        return { success: true as const, duplicate: true, eventId: String(payload.eventId || '') };
      }
      throw new Error('Transfer request already processed.');
    }

    const transferLock = await client.query(
      `
        SELECT *
        FROM public.transfer_requests_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [requestId]
    );
    if (!transferLock.rows.length) throw new Error('Transfer request not found.');
    const transfer = transferLock.rows[0] as Record<string, unknown>;
    if (cleanText(transfer.status).toLowerCase() !== 'pending') {
      throw new Error('Transfer request already processed.');
    }

    const coadminUid = cleanText(transfer.coadmin_uid);
    if (
      !input.isAdmin &&
      coadminUid &&
      cleanText(input.callerCoadminUid) !== coadminUid
    ) {
      throw new Error('Forbidden: transfer request is outside your scope.');
    }

    const playerUid = cleanText(transfer.player_uid);
    const amountNpr = Math.max(0, Math.round(Number(transfer.amount_npr || 0)));
    if (amountNpr <= 0) throw new Error('Transfer request is no longer valid due to low cash balance.');

    const playerLock = await client.query(
      `
        SELECT uid, username, coin, cash, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!playerLock.rows.length) throw new Error('Player profile not found.');
    const player = playerLock.rows[0] as Record<string, unknown>;
    const cashNow = Math.max(0, Math.floor(Number(player.cash || 0)));
    const coinNow = Math.max(0, Math.floor(Number(player.coin || 0)));
    if (cashNow < amountNpr) {
      throw new Error('Transfer request is no longer valid due to low cash balance.');
    }

    const newCash = cashNow - amountNpr;
    const newCoin = coinNow + amountNpr;
    await updatePlayerBalancesInTxn(client, playerUid, { cash: newCash, coin: newCoin });

    const rawTransfer = ((transfer.raw_firestore_data as Record<string, unknown>) || {}) as Record<
      string,
      unknown
    >;
    const transferPatch = {
      ...rawTransfer,
      status: 'approved',
      approvedByUid: input.actorUid,
      approvedByUsername: input.actorUsername,
      approvedAt: nowIso,
      rejectionReason: null,
      processedAt: nowIso,
    };

    await client.query(
      `
        UPDATE public.transfer_requests_cache
        SET
          status = 'approved',
          approved_by_uid = $2,
          approved_by_username = $3,
          approved_at = $4::timestamptz,
          rejection_reason = NULL,
          processed_at = $4::timestamptz,
          source = 'authority_transfer_request_approve',
          mirrored_at = now(),
          raw_firestore_data = $5::jsonb
        WHERE firebase_id = $1 AND deleted_at IS NULL
      `,
      [
        requestId,
        input.actorUid,
        input.actorUsername,
        nowIso,
        JSON.stringify(transferPatch),
      ]
    );

    const eventRaw = {
      playerUid,
      coadminUid,
      amountNpr,
      type: 'transfer',
      transferRequestId: requestId,
      createdAt: nowIso,
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id, player_uid, player_id, coadmin_uid, type,
          amount_npr, transfer_request_id,
          before_cash, after_cash, before_coin, after_coin,
          before_balances, after_balances,
          created_at, updated_at, source, mirrored_at, deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, $2, $2, NULLIF($3, ''), 'transfer',
          $4, $5,
          $6, $7, $8, $9,
          $10::jsonb, $11::jsonb,
          $12::timestamptz, $12::timestamptz, 'authority_transfer_request_approve', now(), NULL,
          $13::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        eventId,
        playerUid,
        coadminUid,
        amountNpr,
        requestId,
        cashNow,
        newCash,
        coinNow,
        newCoin,
        JSON.stringify({ cash: cashNow, coin: coinNow }),
        JSON.stringify({ cash: newCash, coin: newCoin }),
        nowIso,
        JSON.stringify(eventRaw),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `financialEvents:${eventId}:${playerUid}:cash:transfer_request_cash_debit`,
      userUid: playerUid,
      username: cleanText(player.username),
      role: 'player',
      coadminUid,
      balanceType: 'cash',
      direction: 'debit',
      delta: -amountNpr,
      absoluteAfter: newCash,
      eventType: 'transfer_request_cash_debit',
      sourceCollection: 'financial_events_cache',
      sourceId: eventId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: eventRaw,
      sourceFields: { transferRequestId: requestId },
    });

    await insertAuthorityLedgerEvent(client, {
      eventKey: `financialEvents:${eventId}:${playerUid}:coin:transfer_request_coin_credit`,
      userUid: playerUid,
      username: cleanText(player.username),
      role: 'player',
      coadminUid,
      balanceType: 'coin',
      direction: 'credit',
      delta: amountNpr,
      absoluteAfter: newCoin,
      eventType: 'transfer_request_coin_credit',
      sourceCollection: 'financial_events_cache',
      sourceId: eventId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: eventRaw,
      sourceFields: { transferRequestId: requestId },
    });

    await insertLiveOutboxEventWithClient(client, {
      channel: playerTransferLiveChannel(playerUid),
      eventType: 'transfer_request_approved',
      entityType: 'transfer_request',
      entityId: requestId,
      source: 'authority_transfer_request_approve',
      mirroredAt: nowIso,
      payload: {
        entityId: requestId,
        requestId,
        playerUid,
        status: 'approved',
        amountNpr,
        cash: newCash,
        coin: newCoin,
        updatedAt: nowIso,
        source: 'authority',
      },
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ approved: true, eventId, playerUid })]
    );

    await client.query('COMMIT');
    return { success: true as const, duplicate: false, eventId, playerUid };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
