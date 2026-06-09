import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import {
  claimAuthorityOperation,
  insertAuthorityLedgerEvent,
  readAuthorityOperationPayload,
} from '@/lib/sql/authorityLedger';
import { updatePlayerBalancesInTxn } from '@/lib/sql/authorityGameRequestHelpers';
import {
  coadminCashoutLiveChannel,
  insertLiveOutboxEventWithClient,
} from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

function readCashBoxNpr(row: Record<string, unknown>) {
  const raw = (row.raw_firestore_data as Record<string, unknown>) || {};
  return Math.max(0, Number(row.cash_box_npr ?? raw.cashBoxNpr ?? 0));
}

async function upsertCarerCashoutInTxn(
  client: PoolClient,
  input: {
    cashoutId: string;
    data: Record<string, unknown>;
    nowIso: string;
  }
) {
  await client.query(
    `
      INSERT INTO public.carer_cashouts_cache (
        firebase_id, coadmin_uid, carer_uid, carer_username, worker_uid, worker_role,
        amount_npr, completed_amount_npr, remaining_amount_npr, payment_qr_url,
        payment_qr_public_id, payment_details, status, created_at, completed_at,
        source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, NULLIF($2, ''), NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''),
        NULLIF($12, ''), NULLIF($13, ''), $14::timestamptz, $15::timestamptz,
        'authority_carer_cashout', now(), NULL, $16::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        carer_uid = EXCLUDED.carer_uid,
        carer_username = EXCLUDED.carer_username,
        worker_uid = EXCLUDED.worker_uid,
        worker_role = EXCLUDED.worker_role,
        amount_npr = EXCLUDED.amount_npr,
        completed_amount_npr = EXCLUDED.completed_amount_npr,
        remaining_amount_npr = EXCLUDED.remaining_amount_npr,
        payment_qr_url = EXCLUDED.payment_qr_url,
        payment_qr_public_id = EXCLUDED.payment_qr_public_id,
        payment_details = EXCLUDED.payment_details,
        status = EXCLUDED.status,
        completed_at = EXCLUDED.completed_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
    `,
    [
      input.cashoutId,
      cleanText(input.data.coadminUid),
      cleanText(input.data.carerUid),
      cleanText(input.data.carerUsername),
      cleanText(input.data.workerUid || input.data.carerUid),
      cleanText(input.data.workerRole),
      Number(input.data.amountNpr || 0),
      input.data.completedAmountNpr == null ? null : Number(input.data.completedAmountNpr),
      input.data.remainingAmountNpr == null ? null : Number(input.data.remainingAmountNpr),
      cleanText(input.data.paymentQrUrl),
      cleanText(input.data.paymentQrPublicId),
      cleanText(input.data.paymentDetails),
      cleanText(input.data.status),
      cleanText(input.data.createdAt) || input.nowIso,
      cleanText(input.data.completedAt) || null,
      JSON.stringify(input.data),
    ]
  );
}

async function writeCarerCashoutOutbox(
  client: PoolClient,
  input: {
    coadminUid: string;
    cashoutId: string;
    status: string;
    carerUid: string;
    amountNpr: number;
    nowIso: string;
  }
) {
  await insertLiveOutboxEventWithClient(client, {
    channel: coadminCashoutLiveChannel(input.coadminUid),
    eventType: 'carer_cashout',
    entityType: 'carer_cashout',
    entityId: input.cashoutId,
    source: 'authority_carer_cashout',
    mirroredAt: input.nowIso,
    payload: {
      entityId: input.cashoutId,
      cashoutId: input.cashoutId,
      coadminUid: input.coadminUid,
      carerUid: input.carerUid,
      status: input.status,
      amountNpr: input.amountNpr,
      updatedAt: input.nowIso,
      source: 'authority',
    },
  });
}

export async function createCarerCashoutInSql(input: {
  workerUid: string;
  workerRole: string;
  workerUsername: string;
  coadminUid: string;
  amountNpr: number;
  paymentQrUrl?: string | null;
  paymentQrPublicId?: string | null;
  paymentDetails?: string | null;
  actorUid: string;
}) {
  const workerUid = cleanText(input.workerUid);
  const coadminUid = cleanText(input.coadminUid);
  const amountNpr = Math.max(0, Math.round(Number(input.amountNpr || 0)));
  if (!workerUid || !coadminUid) throw new Error('Worker and coadmin scope are required.');
  if (amountNpr <= 0) throw new Error('Cash box amount must be greater than zero.');

  const cashoutId = randomUUID();
  const operationKey = `carer_cashout_create:${cashoutId}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.cashoutId) {
    return { success: true as const, duplicate: true, cashoutId: String(existing.cashoutId) };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'carer_cashout_create',
      userUid: workerUid,
      sourceId: cashoutId,
      actorUid: input.actorUid,
      actorRole: input.workerRole,
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      const payload = await readAuthorityOperationPayload(operationKey);
      if (payload?.cashoutId) {
        return { success: true as const, duplicate: true, cashoutId: String(payload.cashoutId) };
      }
      throw new Error('Duplicate carer cashout create.');
    }

    const workerLock = await client.query(
      `
        SELECT uid, username, role, coadmin_uid, created_by, raw_firestore_data
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [workerUid]
    );
    if (!workerLock.rows.length) throw new Error('Current user profile not found.');
    const worker = workerLock.rows[0] as Record<string, unknown>;
    const role = cleanText(worker.role).toLowerCase();
    if (role !== 'carer' && role !== 'staff') {
      throw new Error('Only staff/carer can create claim pay requests.');
    }

    const snapLock = await client.query(
      `
        SELECT cash_box_npr, raw_firestore_data
        FROM public.user_balance_snapshots_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [workerUid]
    );
    const snap = (snapLock.rows[0] as Record<string, unknown>) || worker;
    const cashBoxBefore = readCashBoxNpr(snap);
    const cashBoxAfter = 0;

    const cashoutRaw = {
      coadminUid,
      carerUid: workerUid,
      carerUsername: input.workerUsername || cleanText(worker.username) || 'Carer',
      workerUid,
      workerRole: role,
      amountNpr,
      paymentQrUrl: input.paymentQrUrl || null,
      paymentQrPublicId: input.paymentQrPublicId || null,
      paymentDetails: input.paymentDetails || null,
      status: 'pending',
      createdAt: nowIso,
      completedAt: null,
      payoutAmountNpr: amountNpr,
      cashBoxBefore,
      cashBoxAfter,
      cashBoxDelta: cashBoxAfter - cashBoxBefore,
      actorUid: input.actorUid,
      actorRole: input.workerRole,
      sourceCashoutId: cashoutId,
      rewardReason: 'claim_pay_create',
    };

    await upsertCarerCashoutInTxn(client, { cashoutId, data: cashoutRaw, nowIso });
    await updatePlayerBalancesInTxn(client, workerUid, { cashBoxNpr: cashBoxAfter });

    await insertAuthorityLedgerEvent(client, {
      eventKey: `carerCashouts:${cashoutId}:${workerUid}:cashBoxNpr:claim_pay_create`,
      userUid: workerUid,
      username: cashoutRaw.carerUsername,
      role,
      coadminUid,
      balanceType: 'cashBoxNpr',
      direction: 'debit',
      delta: cashBoxAfter - cashBoxBefore,
      absoluteAfter: cashBoxAfter,
      eventType: 'claim_pay_create',
      sourceCollection: 'carer_cashouts_cache',
      sourceId: cashoutId,
      actorUid: input.actorUid,
      actorRole: input.workerRole,
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: cashoutRaw,
    });

    await writeCarerCashoutOutbox(client, {
      coadminUid,
      cashoutId,
      status: 'pending',
      carerUid: workerUid,
      amountNpr,
      nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ cashoutId })]
    );

    await client.query('COMMIT');
    return { success: true as const, duplicate: false, cashoutId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeCarerCashoutInSql(input: {
  cashoutId: string;
  doneAmountNpr?: number;
  actorUid: string;
  actorRole: string;
  callerCoadminUid?: string | null;
  isAdmin: boolean;
}) {
  const cashoutId = cleanText(input.cashoutId);
  if (!cashoutId) throw new Error('cashoutId is required.');

  const operationKey = `carer_cashout_complete:${cashoutId}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.completed) {
    return { success: true as const, duplicate: true };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'carer_cashout_complete',
      sourceId: cashoutId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      return { success: true as const, duplicate: true };
    }

    const cashoutLock = await client.query(
      `
        SELECT *
        FROM public.carer_cashouts_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [cashoutId]
    );
    if (!cashoutLock.rows.length) throw new Error('Cashout request not found.');
    const cashout = cashoutLock.rows[0] as Record<string, unknown>;
    if (cleanText(cashout.status).toLowerCase() !== 'pending') {
      throw new Error('Cashout request is already completed.');
    }

    const coadminUid = cleanText(cashout.coadmin_uid);
    if (
      !input.isAdmin &&
      coadminUid &&
      cleanText(input.callerCoadminUid) !== coadminUid
    ) {
      throw new Error('Forbidden: cashout request is outside your scope.');
    }

    const carerUid = cleanText(cashout.carer_uid);
    const requestedAmount = Math.max(0, Math.round(Number(cashout.amount_npr || 0)));
    const resolved =
      Math.max(0, Math.round(Number(input.doneAmountNpr || 0))) > 0
        ? Math.max(0, Math.round(Number(input.doneAmountNpr || 0)))
        : requestedAmount;
    if (resolved > requestedAmount) {
      throw new Error('Done amount cannot be greater than claim amount.');
    }
    const remainingAmountNpr = Math.max(0, requestedAmount - resolved);

    const workerLock = await client.query(
      `
        SELECT cash_box_npr, raw_firestore_data
        FROM public.user_balance_snapshots_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [carerUid]
    );
    const workerSnap = (workerLock.rows[0] as Record<string, unknown>) || {};
    const cashBoxBefore = readCashBoxNpr(workerSnap);
    const cashBoxAfter = remainingAmountNpr;

    const pending = await client.query(
      `
        SELECT firebase_id, raw_firestore_data
        FROM public.carer_cashouts_cache
        WHERE carer_uid = $1
          AND status = 'pending'
          AND deleted_at IS NULL
        FOR UPDATE
      `,
      [carerUid]
    );

    for (const row of pending.rows) {
      const id = cleanText((row as { firebase_id?: string }).firebase_id);
      const raw = ((row as { raw_firestore_data?: Record<string, unknown> }).raw_firestore_data ||
        {}) as Record<string, unknown>;
      const isTarget = id === cashoutId;
      const patch = {
        ...raw,
        status: 'completed',
        completedAt: nowIso,
        ...(isTarget
          ? {
              completedAmountNpr: resolved,
              remainingAmountNpr,
              payoutAmountNpr: resolved,
              cashBoxBefore,
              cashBoxAfter,
              cashBoxDelta: cashBoxAfter - cashBoxBefore,
              actorUid: input.actorUid,
              actorRole: input.actorRole,
              sourceCashoutId: cashoutId,
              rewardReason: 'claim_pay_complete',
            }
          : {}),
      };
      await upsertCarerCashoutInTxn(client, {
        cashoutId: id,
        data: patch,
        nowIso,
      });
    }

    await updatePlayerBalancesInTxn(client, carerUid, { cashBoxNpr: cashBoxAfter });

    if (coadminUid) {
      await writeCarerCashoutOutbox(client, {
        coadminUid,
        cashoutId,
        status: 'completed',
        carerUid,
        amountNpr: resolved,
        nowIso,
      });
    }

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ completed: true })]
    );

    await client.query('COMMIT');
    return { success: true as const, duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function declineCarerCashoutInSql(input: {
  cashoutId: string;
  actorUid: string;
  actorRole: string;
  callerCoadminUid?: string | null;
  isAdmin: boolean;
}) {
  const cashoutId = cleanText(input.cashoutId);
  if (!cashoutId) throw new Error('cashoutId is required.');

  const operationKey = `carer_cashout_decline:${cashoutId}`;
  const existing = await readAuthorityOperationPayload(operationKey);
  if (existing?.declined) {
    return { success: true as const, duplicate: true };
  }

  const db = getPlayerMirrorPool();
  if (!db) throw new Error('Postgres is unavailable.');
  const nowIso = new Date().toISOString();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const claim = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'carer_cashout_decline',
      sourceId: cashoutId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      payload: {},
    });
    if (claim.duplicate) {
      await client.query('ROLLBACK');
      return { success: true as const, duplicate: true };
    }

    const cashoutLock = await client.query(
      `
        SELECT *
        FROM public.carer_cashouts_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [cashoutId]
    );
    if (!cashoutLock.rows.length) throw new Error('Cashout request not found.');
    const cashout = cashoutLock.rows[0] as Record<string, unknown>;
    if (cleanText(cashout.status).toLowerCase() !== 'pending') {
      throw new Error('Only pending cashout requests can be declined.');
    }

    const coadminUid = cleanText(cashout.coadmin_uid);
    if (
      !input.isAdmin &&
      coadminUid &&
      cleanText(input.callerCoadminUid) !== coadminUid
    ) {
      throw new Error('Forbidden: cashout request is outside your scope.');
    }

    const carerUid = cleanText(cashout.carer_uid);
    const amountNpr = Math.max(0, Math.round(Number(cashout.amount_npr || 0)));

    const workerLock = await client.query(
      `
        SELECT cash_box_npr, raw_firestore_data
        FROM public.user_balance_snapshots_cache
        WHERE firebase_id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [carerUid]
    );
    const workerSnap = (workerLock.rows[0] as Record<string, unknown>) || {};
    const currentCashBox = readCashBoxNpr(workerSnap);
    const cashBoxAfter = currentCashBox + amountNpr;

    const raw = ((cashout.raw_firestore_data as Record<string, unknown>) || {}) as Record<
      string,
      unknown
    >;
    const patch = {
      ...raw,
      coadminUid,
      carerUid,
      amountNpr,
      status: 'declined',
      completedAt: nowIso,
      completedAmountNpr: 0,
      remainingAmountNpr: amountNpr,
      payoutAmountNpr: 0,
      cashBoxBefore: currentCashBox,
      cashBoxAfter,
      cashBoxDelta: cashBoxAfter - currentCashBox,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      sourceCashoutId: cashoutId,
      rewardReason: 'claim_pay_decline',
    };

    await upsertCarerCashoutInTxn(client, { cashoutId, data: patch, nowIso });
    await updatePlayerBalancesInTxn(client, carerUid, { cashBoxNpr: cashBoxAfter });

    await insertAuthorityLedgerEvent(client, {
      eventKey: `carerCashouts:${cashoutId}:${carerUid}:cashBoxNpr:claim_pay_decline`,
      userUid: carerUid,
      role: cleanText(cashout.worker_role) || 'carer',
      coadminUid,
      balanceType: 'cashBoxNpr',
      direction: 'credit',
      delta: amountNpr,
      absoluteAfter: cashBoxAfter,
      eventType: 'claim_pay_decline',
      sourceCollection: 'carer_cashouts_cache',
      sourceId: cashoutId,
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      confidence: 'high',
      sourceCreatedAt: nowIso,
      rawSourceData: patch,
    });

    if (coadminUid) {
      await writeCarerCashoutOutbox(client, {
        coadminUid,
        cashoutId,
        status: 'declined',
        carerUid,
        amountNpr,
        nowIso,
      });
    }

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [operationKey, JSON.stringify({ declined: true })]
    );

    await client.query('COMMIT');
    return { success: true as const, duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
