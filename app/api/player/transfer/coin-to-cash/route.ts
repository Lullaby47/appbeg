import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  getCoadminMaintenanceBreak,
  maintenanceBreakApiResponse,
  rejectIfPlayerMaintenanceBreak,
} from '@/lib/maintenance/admin';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

type Body = {
  amountCoins?: unknown;
  transferId?: unknown;
};

function parsePositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed !== Math.floor(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

function parseTransferId(value: unknown) {
  const transferId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(transferId)) {
    return '';
  }
  return transferId;
}

function getCoinToCashTip(amountCoins: number) {
  if (amountCoins >= 150) return 10;
  if (amountCoins >= 100) return 8;
  if (amountCoins >= 40) return 4;
  if (amountCoins >= 30) return 3;
  if (amountCoins >= 20) return 2;
  if (amountCoins >= 10) return 1;
  return 0;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;
    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'coin_to_cash');

    const body = (await request.json()) as Body;
    const amountCoins = parsePositiveInteger(body.amountCoins);
    const transferId = parseTransferId(body.transferId);
    if (!amountCoins) {
      return apiError('Amount must be a positive whole number.', 400);
    }
    if (amountCoins < 10) {
      return apiError('Minimum Coin to Cash amount is 10.', 400);
    }
    if (!transferId) {
      return apiError('Transfer id is required.', 400);
    }

    const playerUid = auth.user.uid;
    const playerRef = adminDb.collection('users').doc(playerUid);
    const eventRef = adminDb.collection('financialEvents').doc(`coinToCash_${playerUid}_${transferId}`);
    const tipAmount = getCoinToCashTip(amountCoins);
    const cashReceived = amountCoins - tipAmount;
    if (cashReceived <= 0) {
      return apiError('Transfer amount is too low after tip.', 400);
    }

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
        throw new Error('Only players can transfer coin to cash.');
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
      if (currentCoin < amountCoins) {
        throw new Error('Not enough coin available for transfer.');
      }

      const coadminUid = String(playerData.coadminUid || playerData.createdBy || '').trim() || null;
      const maintenanceBreak = await getCoadminMaintenanceBreak(coadminUid || '');
      if (maintenanceBreak.enabled) {
        console.info('[MAINTENANCE] blocked player action', {
          action: 'coin_to_cash',
          playerUid,
          coadminUid,
        });
        throw new Error(`MAINTENANCE_BREAK:${maintenanceBreak.message}`);
      }

      newCoin = currentCoin - amountCoins;
      newCash = currentCash + cashReceived;

      transaction.update(playerRef, {
        cash: newCash,
        coin: newCoin,
      });

      transaction.set(eventRef, {
        playerUid,
        playerId: playerUid,
        coadminUid,
        transferAmount: amountCoins,
        amountCoins,
        feeAmount: tipAmount,
        tipAmount,
        tipNpr: tipAmount,
        cashReceived,
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
        type: 'coin_to_cash_transfer',
        timestamp: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    void mirrorFinancialEventById(eventRef.id, 'appbeg_coin_to_cash_transfer');
    void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_coin_to_cash_transfer');
    return NextResponse.json({
      success: true,
      cash: newCash,
      coin: newCoin,
      transferAmount: amountCoins,
      feeAmount: tipAmount,
      tipAmount,
      cashReceived,
      transferId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to transfer coin to cash.';
    if (message.startsWith('MAINTENANCE_BREAK:')) {
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }
    const status = /not authenticated|authorization|token/i.test(message)
      ? 401
      : /forbidden|blocked/i.test(message)
      ? 403
      : /duplicate|already/i.test(message)
      ? 409
      : /required|valid|not found|only|amount|coin|transfer/i.test(message)
      ? 400
      : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
