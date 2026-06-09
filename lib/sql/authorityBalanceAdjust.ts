import 'server-only';

import { randomUUID } from 'crypto';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { claimAuthorityOperation, insertAuthorityLedgerEvent } from '@/lib/sql/authorityLedger';
import { lookupUserDirectoryFromSql, resolvePlayerScopeUid } from '@/lib/sql/authorityLookup';

export type AuthorityBalanceAdjustInput = {
  playerUid: string;
  delta: number;
  balanceType: 'coin' | 'cash';
  actorUid: string;
  actorRole: string;
  scopeUid: string | null;
  isAdmin: boolean;
  idempotencyKey?: string | null;
};

export type AuthorityBalanceAdjustResult = {
  success: true;
  duplicate: boolean;
  eventId: string;
  playerUid: string;
  balanceType: 'coin' | 'cash';
  before: number;
  after: number;
  delta: number;
};

function resolveEventType(balanceType: 'coin' | 'cash', delta: number) {
  if (balanceType === 'coin') {
    return delta > 0 ? 'coadmin_coin_add' : 'coadmin_coin_deduct';
  }
  return delta > 0 ? 'coadmin_cash_add' : 'coadmin_cash_deduct';
}

export async function adjustPlayerBalanceInSql(
  input: AuthorityBalanceAdjustInput
): Promise<AuthorityBalanceAdjustResult> {
  const playerUid = cleanText(input.playerUid);
  const delta = Math.trunc(input.delta);
  const balanceType = input.balanceType;
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole);
  const scopeUid = cleanText(input.scopeUid);

  if (!playerUid || !actorUid || !actorRole) {
    throw new Error('playerUid, actorUid, and actorRole are required.');
  }
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('Amount must be a non-zero whole number.');
  }
  if (balanceType !== 'coin' && balanceType !== 'cash') {
    throw new Error("balanceType must be 'coin' or 'cash'.");
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('Postgres is unavailable.');
  }

  const eventId = randomUUID();
  const nowIso = new Date().toISOString();
  const idempotencyKey = cleanText(input.idempotencyKey);
  const operationKey = idempotencyKey
    ? `balance_adjust:${idempotencyKey}`
    : `balance_adjust:${eventId}`;
  const eventType = resolveEventType(balanceType, delta);
  const amountNpr = Math.abs(delta);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'balance_adjust',
      userUid: playerUid,
      sourceId: eventId,
      actorUid,
      actorRole,
      payload: {
        delta,
        balanceType,
        eventType,
      },
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const existing = await lookupUserDirectoryFromSql(playerUid);
      if (!existing) {
        throw new Error('Player not found.');
      }
      const current = balanceType === 'coin' ? existing.coin : existing.cash;
      return {
        success: true,
        duplicate: true,
        eventId,
        playerUid,
        balanceType,
        before: current,
        after: current,
        delta: 0,
      };
    }

    const locked = await client.query(
      `
        SELECT
          uid,
          username,
          role,
          coadmin_uid,
          created_by,
          coin,
          cash,
          raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [playerUid]
    );
    if (!locked.rows.length) {
      throw new Error('Player not found.');
    }

    const row = locked.rows[0] as Record<string, unknown>;
    const raw =
      row.raw_firestore_data &&
      typeof row.raw_firestore_data === 'object' &&
      !Array.isArray(row.raw_firestore_data)
        ? (row.raw_firestore_data as Record<string, unknown>)
        : {};
    const mapped = {
      uid: playerUid,
      username: cleanText(row.username) || cleanText(raw.username) || null,
      email: null,
      role: cleanText(row.role) || cleanText(raw.role) || 'player',
      status: null,
      coadminUid: cleanText(row.coadmin_uid) || cleanText(raw.coadminUid) || null,
      createdBy: cleanText(row.created_by) || cleanText(raw.createdBy) || null,
      coin: Math.max(0, Math.floor(Number(row.coin ?? raw.coin ?? 0))),
      cash: Math.max(0, Math.floor(Number(row.cash ?? raw.cash ?? 0))),
    };

    if (String(mapped.role || '').toLowerCase() !== 'player') {
      throw new Error('This account is not a player.');
    }

    const playerScope = resolvePlayerScopeUid(mapped);
    if (!input.isAdmin && playerScope !== scopeUid) {
      throw new Error('Forbidden: this player is outside your scope.');
    }

    const current = balanceType === 'coin' ? mapped.coin : mapped.cash;
    const next = current + delta;
    if (next < 0) {
      throw new Error(
        balanceType === 'coin'
          ? 'Not enough coin to deduct that amount.'
          : 'Not enough cash to deduct that amount.'
      );
    }

    const balanceColumn = balanceType === 'coin' ? 'coin' : 'cash';
    await client.query(
      `
        UPDATE public.players_cache
        SET
          ${balanceColumn} = $2,
          updated_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object($4, $2)
        WHERE uid = $1
          AND deleted_at IS NULL
      `,
      [playerUid, next, nowIso, balanceColumn]
    );

    await client.query(
      `
        UPDATE public.user_balance_snapshots_cache
        SET
          ${balanceColumn} = $2,
          updated_at = $3::timestamptz,
          mirrored_at = now(),
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object($4, $2)
        WHERE firebase_id = $1
          AND deleted_at IS NULL
      `,
      [playerUid, next, nowIso, balanceColumn]
    );

    const rawEvent = {
      playerUid,
      coadminUid: playerScope,
      amountNpr,
      type: eventType,
      createdAt: nowIso,
    };

    await client.query(
      `
        INSERT INTO public.financial_events_cache (
          firebase_id,
          player_uid,
          coadmin_uid,
          type,
          amount_npr,
          before_coin,
          after_coin,
          before_cash,
          after_cash,
          actor_uid,
          actor_role,
          created_at,
          updated_at,
          source,
          mirrored_at,
          deleted_at,
          raw_firestore_data
        )
        VALUES (
          $1, $2, NULLIF($3, ''), $4, $5,
          $6, $7, $8, $9,
          NULLIF($10, ''), NULLIF($11, ''),
          $12::timestamptz, $12::timestamptz,
          'authority_balance_adjust', now(), NULL,
          $13::jsonb
        )
        ON CONFLICT (firebase_id) DO NOTHING
      `,
      [
        eventId,
        playerUid,
        playerScope,
        eventType,
        amountNpr,
        balanceType === 'coin' ? current : mapped.coin,
        balanceType === 'coin' ? next : mapped.coin,
        balanceType === 'cash' ? current : mapped.cash,
        balanceType === 'cash' ? next : mapped.cash,
        actorUid,
        actorRole,
        nowIso,
        JSON.stringify(rawEvent),
      ]
    );

    await insertAuthorityLedgerEvent(client, {
      eventKey: `authority:balance_adjust:${eventId}`,
      userUid: playerUid,
      username: mapped.username,
      role: mapped.role,
      coadminUid: playerScope,
      balanceType,
      direction: delta > 0 ? 'credit' : 'debit',
      delta,
      absoluteAfter: next,
      eventType,
      sourceCollection: 'financialEvents',
      sourceId: eventId,
      actorUid,
      actorRole,
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: rawEvent,
      sourceFields: {
        amountNpr,
        balanceType,
        before: current,
        after: next,
      },
    });

    await client.query('COMMIT');
    return {
      success: true,
      duplicate: false,
      eventId,
      playerUid,
      balanceType,
      before: current,
      after: next,
      delta,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
