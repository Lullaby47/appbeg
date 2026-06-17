import 'server-only';

import type { PoolClient } from 'pg';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export type AuthorityLedgerInsert = {
  eventKey: string;
  userUid: string;
  username?: string | null;
  role?: string | null;
  coadminUid?: string | null;
  balanceType: 'coin' | 'cash' | 'cashBoxNpr' | 'promoLockedCoins' | 'referralBonusCoins';
  direction: 'credit' | 'debit' | 'set' | 'baseline' | 'residual';
  delta: number;
  absoluteAfter: number;
  eventType: string;
  sourceCollection: string;
  sourceId: string;
  actorUid?: string | null;
  actorRole?: string | null;
  confidence?: 'high' | 'medium' | 'low' | 'baseline' | 'residual';
  sourceCreatedAt?: string | null;
  rawSourceData?: Record<string, unknown>;
  sourceFields?: Record<string, unknown>;
};

export async function insertAuthorityLedgerEvent(
  client: PoolClient,
  input: AuthorityLedgerInsert
): Promise<boolean> {
  const eventKey = cleanText(input.eventKey);
  const userUid = cleanText(input.userUid);
  const sourceId = cleanText(input.sourceId);
  if (!eventKey || !userUid || !sourceId) {
    throw new Error('eventKey, userUid, and sourceId are required for authority ledger insert.');
  }

  const result = await client.query(
    `
      INSERT INTO public.user_balance_events (
        event_key,
        user_uid,
        username,
        role,
        coadmin_uid,
        balance_type,
        direction,
        delta,
        absolute_after,
        event_type,
        source_collection,
        source_id,
        actor_uid,
        actor_role,
        confidence,
        source_created_at,
        raw_source_data,
        source_fields,
        created_by_backfill,
        deleted_at
      )
      VALUES (
        $1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        $6, $7, $8, $9, $10,
        $11, $12, NULLIF($13, ''), NULLIF($14, ''), $15,
        COALESCE($16::timestamptz, now()), $17::jsonb, $18::jsonb,
        FALSE, NULL
      )
      ON CONFLICT (event_key) DO NOTHING
    `,
    [
      eventKey,
      userUid,
      cleanText(input.username),
      cleanText(input.role),
      cleanText(input.coadminUid),
      input.balanceType,
      input.direction,
      input.delta,
      input.absoluteAfter,
      cleanText(input.eventType),
      cleanText(input.sourceCollection),
      sourceId,
      cleanText(input.actorUid),
      cleanText(input.actorRole),
      input.confidence || 'high',
      input.sourceCreatedAt || null,
      JSON.stringify(input.rawSourceData || {}),
      JSON.stringify(input.sourceFields || {}),
    ]
  );

  return (result.rowCount || 0) > 0;
}

export async function claimAuthorityOperation(
  client: PoolClient,
  input: {
    operationKey: string;
    operationType: string;
    userUid?: string | null;
    sourceId?: string | null;
    actorUid?: string | null;
    actorRole?: string | null;
    payload?: Record<string, unknown>;
  }
): Promise<{ claimed: boolean; duplicate: boolean }> {
  const operationKey = cleanText(input.operationKey);
  if (!operationKey) {
    throw new Error('operationKey is required.');
  }

  const result = await client.query(
    `
      INSERT INTO public.authority_operations (
        operation_key,
        operation_type,
        user_uid,
        source_id,
        actor_uid,
        actor_role,
        payload
      )
      VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7::jsonb)
      ON CONFLICT (operation_key) DO NOTHING
      RETURNING operation_key
    `,
    [
      operationKey,
      cleanText(input.operationType),
      cleanText(input.userUid),
      cleanText(input.sourceId),
      cleanText(input.actorUid),
      cleanText(input.actorRole),
      JSON.stringify(input.payload || {}),
    ]
  );

  if ((result.rowCount || 0) > 0) {
    return { claimed: true, duplicate: false };
  }
  return { claimed: false, duplicate: true };
}

export async function readAuthorityOperationExists(operationKey: string): Promise<boolean> {
  const key = cleanText(operationKey);
  if (!key) {
    return false;
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    return false;
  }

  const result = await db.query(
    `
      SELECT 1
      FROM public.authority_operations
      WHERE operation_key = $1
      LIMIT 1
    `,
    [key]
  );
  return result.rows.length > 0;
}

export function logAuthPayloadPreTxnRemoved(flowName: string) {
  console.info('[AUTH_PAYLOAD_PRE_TXN_REMOVED]', { flowName, savedRoundTrip: true });
}

export function logAuthDuplicatePayloadReadInTxn(flowName: string, operationKey: string) {
  console.info('[AUTH_DUPLICATE_PAYLOAD_READ_IN_TXN]', {
    flowName,
    operationKey: cleanText(operationKey),
    source: 'same_client',
  });
}

function parseAuthorityOperationPayloadValue(payload: unknown): Record<string, unknown> | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

export async function readAuthorityOperationPayloadWithClient(
  client: PoolClient,
  operationKey: string,
  options?: { flowName?: string }
): Promise<Record<string, unknown> | null> {
  const key = cleanText(operationKey);
  if (!key) {
    return null;
  }
  if (options?.flowName) {
    logAuthDuplicatePayloadReadInTxn(options.flowName, key);
  }
  const result = await client.query(
    `
      SELECT payload
      FROM public.authority_operations
      WHERE operation_key = $1
      LIMIT 1
    `,
    [key]
  );
  if (!result.rows.length) {
    return null;
  }
  return parseAuthorityOperationPayloadValue(result.rows[0]?.payload);
}

export async function readAuthorityOperationPayload(
  operationKey: string
): Promise<Record<string, unknown> | null> {
  const key = cleanText(operationKey);
  if (!key) {
    return null;
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    return null;
  }

  const result = await db.query(
    `
      SELECT payload
      FROM public.authority_operations
      WHERE operation_key = $1
      LIMIT 1
    `,
    [key]
  );
  if (!result.rows.length) {
    return null;
  }
  return parseAuthorityOperationPayloadValue(result.rows[0]?.payload);
}

export async function deleteAuthorityOperationInTxn(
  client: import('pg').PoolClient,
  operationKey: string
): Promise<boolean> {
  const key = cleanText(operationKey);
  if (!key) {
    return false;
  }
  const result = await client.query(
    `
      DELETE FROM public.authority_operations
      WHERE operation_key = $1
    `,
    [key]
  );
  return (result.rowCount || 0) > 0;
}

export async function deleteAuthorityOperationsByPrefixInTxn(
  client: import('pg').PoolClient,
  prefix: string
): Promise<number> {
  const cleanPrefix = cleanText(prefix);
  if (!cleanPrefix) {
    return 0;
  }
  const result = await client.query(
    `
      DELETE FROM public.authority_operations
      WHERE operation_key LIKE $1
    `,
    [`${cleanPrefix}%`]
  );
  return result.rowCount || 0;
}
