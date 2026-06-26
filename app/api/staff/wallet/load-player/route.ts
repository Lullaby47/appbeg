import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  authoritySqlWriteEnvLogFields,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { loadPlayerCoinsFromStaffWalletInSql } from '@/lib/sql/staffWalletAuthority';

export const runtime = 'nodejs';

const ROUTE = '/api/staff/wallet/load-player';

type Body = {
  playerUid?: unknown;
  amount?: unknown;
  idempotencyKey?: unknown;
};

function parsePositiveIntegerAmount(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('invalid_amount');
  }
  return amount;
}

function statusForError(message: string) {
  if (/not authenticated|authorization|token/i.test(message)) return 401;
  if (/out_of_scope_player|outside your scope|forbidden|not linked/i.test(message)) return 403;
  if (/insufficient_staff_wallet_balance/i.test(message)) return 409;
  if (/idempotency_conflict/i.test(message)) return 409;
  if (/postgres|database|unavailable/i.test(message)) return 503;
  if (/invalid_amount|missing_idempotency_key|invalid_player|required|positive|whole/i.test(message)) {
    return 400;
  }
  return 409;
}

function errorCode(message: string) {
  if (/insufficient_staff_wallet_balance/i.test(message)) return 'insufficient_staff_wallet_balance';
  if (/out_of_scope_player|outside your scope/i.test(message)) return 'out_of_scope_player';
  if (/idempotency_conflict/i.test(message)) return 'idempotency_conflict';
  if (/missing_idempotency_key/i.test(message)) return 'missing_idempotency_key';
  if (/invalid_amount|positive|whole/i.test(message)) return 'invalid_amount';
  if (/invalid_player|not found|not a player/i.test(message)) return 'invalid_player';
  return 'staff_wallet_load_failed';
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['staff']);
    if ('response' in auth) {
      return auth.response;
    }

    const body = (await request.json().catch(() => ({}))) as Body;
    const playerUid = String(body.playerUid || '').trim();
    if (!playerUid) {
      return apiError('invalid_player', 400);
    }

    let amount: number;
    try {
      amount = parsePositiveIntegerAmount(body.amount);
    } catch {
      return apiError('invalid_amount', 400);
    }

    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim();
    if (!idempotencyKey) {
      return apiError('missing_idempotency_key', 400);
    }

    const scopeUid = scopedCoadminUid(auth.user);
    if (!scopeUid) {
      return apiError('Your account is not linked to a coadmin scope.', 403);
    }

    const result = await loadPlayerCoinsFromStaffWalletInSql({
      playerUid,
      amount,
      actorUid: auth.user.uid,
      actorRole: auth.user.role,
      scopeUid,
      idempotencyKey,
    });

    logAuthoritySqlWrite(ROUTE, {
      ...authoritySqlWriteEnvLogFields(),
      staffUid: result.staffUid,
      playerUid: result.playerUid,
      coadminUid: result.coadminUid,
      loadedAmount: result.loadedAmount,
      staffWalletBalanceCoin: result.staffWalletBalanceCoin,
      playerBalanceCoin: result.playerBalanceCoin,
      duplicate: result.duplicate,
      eventId: result.eventId,
    });

    return NextResponse.json({
      ok: true,
      staffUid: result.staffUid,
      playerUid: result.playerUid,
      loadedAmount: result.loadedAmount,
      staffWalletBalanceCoin: result.staffWalletBalanceCoin,
      playerBalanceCoin: result.playerBalanceCoin,
      duplicate: result.duplicate,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load player coins from staff wallet.';
    const code = errorCode(message);
    return NextResponse.json({ error: code }, { status: statusForError(message) });
  }
}
