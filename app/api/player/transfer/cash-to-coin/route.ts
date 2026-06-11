import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  getCoadminMaintenanceBreak,
  maintenanceBreakApiResponse,
  rejectIfPlayerMaintenanceBreak,
  rejectIfPlayerMaintenanceBreakFromUser,
} from '@/lib/maintenance/admin';
import {
  authoritySqlWriteEnvLogFields,
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import {
  getCashToCoinFee,
  parsePositiveInteger,
  parseTransferId,
} from '@/lib/server/playerTransferRules';
import { transferCashToCoinInSql } from '@/lib/sql/authorityTransfer';
import { getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export const runtime = 'nodejs';

const ROUTE = '/api/player/transfer/cash-to-coin';

type Body = {
  amountNpr?: unknown;
  transferId?: unknown;
  idempotencyKey?: unknown;
};

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const amountNpr = parsePositiveInteger(body.amountNpr);
    const transferId = parseTransferId(body.transferId);
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() ||
      transferId ||
      null;

    if (!amountNpr) {
      return apiError('Amount must be a positive whole number.', 400);
    }
    if (!transferId) {
      return apiError('Transfer id is required.', 400);
    }

    const feeAmount = getCashToCoinFee(amountNpr);
    const coinsReceived = amountNpr - feeAmount;
    if (coinsReceived <= 0) {
      return apiError('Transfer amount is too low after fee.', 400);
    }

    if (isAuthoritySqlWriteEnabled()) {
      await rejectIfPlayerMaintenanceBreakFromUser(auth.user, 'cash_to_coin');

      const result = await transferCashToCoinInSql({
        playerUid: auth.user.uid,
        amountNpr,
        transferId,
        idempotencyKey,
      });
      const poolStats = getPlayerMirrorPoolStats();

      logAuthoritySqlWrite(ROUTE, {
        ...authoritySqlWriteEnvLogFields(),
        playerUid: auth.user.uid,
        transferId,
        duplicate: result.duplicate,
        transferAmount: result.transferAmount,
        route: ROUTE,
        pool_totalCount: poolStats?.totalCount ?? null,
        pool_idleCount: poolStats?.idleCount ?? null,
        pool_waitingCount: poolStats?.waitingCount ?? null,
        pool_max: poolStats?.max ?? null,
      });

      return NextResponse.json({
        success: true,
        cash: result.cash,
        coin: result.coin,
        transferAmount: result.transferAmount,
        feeAmount: result.feeAmount,
        tipAmount: result.tipAmount,
        coinsReceived: result.coinsReceived,
        transferId: result.transferId,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'cash_to_coin');

    const playerUid = auth.user.uid;
    const playerRef = adminDb.collection('users').doc(playerUid);
    const eventRef = adminDb.collection('financialEvents').doc(`cashToCoin_${playerUid}_${transferId}`);
    let newCash = 0;
    let newCoin = 0;

    await adminDb.runTransaction(async (transaction) => {
      const existingEventSnap = await transaction.get(eventRef);
      if (existingEventSnap.exists) {
        throw new Error('Duplicate transfer id.');
      }

      const playerSnap = await transaction.get(playerRef);
      if (!playerSnap.exists) {
        throw new Error('Player profile not found.');
      }

      const playerData = playerSnap.data() as {
        role?: string;
        status?: string;
        cash?: number;
        coin?: number;
        transferBlockedUntil?: { toMillis?: () => number } | null;
        coadminUid?: string | null;
        createdBy?: string | null;
      };

      if (String(playerData.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can transfer cash to coin.');
      }

      if (String(playerData.status || '').toLowerCase() === 'disabled') {
        throw new Error('Your account is blocked.');
      }

      const blockedUntilMs = playerData.transferBlockedUntil?.toMillis?.() || 0;
      if (blockedUntilMs > Date.now()) {
        throw new Error('Transfer is temporarily blocked. Contact staff.');
      }

      const currentCash = Math.max(0, Number(playerData.cash || 0));
      const currentCoin = Math.max(0, Number(playerData.coin || 0));
      if (currentCash < amountNpr) {
        throw new Error('Not enough cash available for transfer.');
      }

      const coadminUid = String(playerData.coadminUid || playerData.createdBy || '').trim() || null;
      const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid || '');
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked player action', {
          action: 'cash_to_coin',
          playerUid,
          coadminUid,
        });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }

      newCash = currentCash - amountNpr;
      newCoin = currentCoin + coinsReceived;

      transaction.update(playerRef, {
        cash: newCash,
        coin: newCoin,
      });

      transaction.set(eventRef, {
        playerUid,
        playerId: playerUid,
        coadminUid,
        transferAmount: amountNpr,
        amountNpr,
        feeAmount,
        tipAmount: 0,
        tipNpr: 0,
        coinsReceived,
        beforeCash: currentCash,
        afterCash: newCash,
        beforeCoins: currentCoin,
        afterCoins: newCoin,
        beforeCoin: currentCoin,
        afterCoin: newCoin,
        beforeBalances: {
          cash: currentCash,
          coin: currentCoin,
        },
        afterBalances: {
          cash: newCash,
          coin: newCoin,
        },
        transferId,
        type: 'cash_to_coin_transfer',
        timestamp: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    void mirrorFinancialEventById(eventRef.id, 'appbeg_cash_to_coin_transfer');
    void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_cash_to_coin_transfer');
    return NextResponse.json({
      success: true,
      cash: newCash,
      coin: newCoin,
      transferAmount: amountNpr,
      feeAmount,
      tipAmount: 0,
      coinsReceived,
      transferId,
      authority: 'firestore',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to transfer cash to coin.';
    if (message.startsWith('MAINTENANCE_BREAK:')) {
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }
    const status = /not authenticated|authorization|token/i.test(message)
      ? 401
      : /forbidden|blocked/i.test(message)
        ? 403
        : /duplicate|already/i.test(message)
          ? 409
          : /required|valid|not found|only|amount|cash|transfer/i.test(message)
            ? 400
            : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
