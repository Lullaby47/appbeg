import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  authoritySqlWriteEnvLogFields,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { allocateStaffWalletCoinsInSql } from '@/lib/sql/staffWalletAuthority';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/staff-wallets/allocate';

type Body = {
  staffUid?: unknown;
  amount?: unknown;
  idempotencyKey?: unknown;
  note?: unknown;
};

function parsePositiveIntegerAmount(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('Amount must be a positive whole number.');
  }
  return amount;
}

function statusForError(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/forbidden|outside your scope|not linked/i.test(message)) return 403;
  if (/duplicate idempotency/i.test(message)) return 409;
  if (/postgres|database|unavailable/i.test(message)) return 503;
  if (/required|positive|whole|not found|not a staff|staff/i.test(message)) return 400;
  return 409;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['coadmin', 'admin']);
    if ('response' in auth) {
      return auth.response;
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    const staffUid = String(body.staffUid || '').trim();
    if (!staffUid) {
      return apiError('staffUid is required.', 400);
    }

    let amount: number;
    try {
      amount = parsePositiveIntegerAmount(body.amount);
    } catch (error) {
      return apiError(
        error instanceof Error ? error.message : 'Amount must be a positive whole number.',
        400
      );
    }

    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;
    const note = String(body.note || '').trim() || null;
    const scopeUid = scopedCoadminUid(auth.user);

    if (auth.user.role !== 'admin' && !scopeUid) {
      return apiError('Your account is not linked to a coadmin scope.', 403);
    }

    const result = await allocateStaffWalletCoinsInSql({
      staffUid,
      amount,
      actorUid: auth.user.uid,
      actorRole: auth.user.role,
      scopeUid,
      isAdmin: auth.user.role === 'admin',
      idempotencyKey,
      note,
    });

    logAuthoritySqlWrite(ROUTE, {
      ...authoritySqlWriteEnvLogFields(),
      staffUid: result.staffUid,
      coadminUid: result.coadminUid,
      actorUid: auth.user.uid,
      actorRole: auth.user.role,
      amount,
      allocatedAmount: result.allocatedAmount,
      balanceCoin: result.balanceCoin,
      totalAllocatedCoin: result.totalAllocatedCoin,
      duplicate: result.duplicate,
      eventId: result.eventId,
    });

    return NextResponse.json({
      ok: true,
      staffUid: result.staffUid,
      balanceCoin: result.balanceCoin,
      totalAllocatedCoin: result.totalAllocatedCoin,
      allocatedAmount: result.allocatedAmount,
      duplicate: result.duplicate,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to allocate staff wallet coins.';
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
