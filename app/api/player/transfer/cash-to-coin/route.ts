import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  getCoadminMaintenanceBreak,
  maintenanceBreakApiResponse,
  rejectIfPlayerMaintenanceBreak,
} from '@/lib/maintenance/admin';

type Body = {
  amountNpr?: unknown;
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

function getCashToCoinTip(amountNpr: number) {
  if (amountNpr >= 450) return 35;
  if (amountNpr >= 300) return 20;
  if (amountNpr >= 200) return 12;
  if (amountNpr >= 150) return 8;
  if (amountNpr >= 100) return 5;
  if (amountNpr >= 30) return 3;
  if (amountNpr >= 10) return 1;
  return 0;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;
    await rejectIfPlayerMaintenanceBreak(auth.user.uid, 'cash_to_coin');

    const body = (await request.json()) as Body;
    const amountNpr = parsePositiveInteger(body.amountNpr);
    const transferId = parseTransferId(body.transferId);
    if (!amountNpr) {
      return apiError('Amount must be a positive whole number.', 400);
    }
    if (amountNpr < 10) {
      return apiError('Minimum transfer amount is $10.', 400);
    }
    if (!transferId) {
      return apiError('Transfer id is required.', 400);
    }

    const playerUid = auth.user.uid;
    const playerRef = adminDb.collection('users').doc(playerUid);
    const eventRef = adminDb.collection('financialEvents').doc(`cashToCoin_${playerUid}_${transferId}`);
    const tipAmount = getCashToCoinTip(amountNpr);
    const coinsReceived = amountNpr - tipAmount;
    let newCash = 0;
    let newCoin = 0;

    if (coinsReceived <= 0) {
      return apiError('Coins received must be greater than zero.', 400);
    }

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
        tipAmount,
        tipNpr: tipAmount,
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

    return NextResponse.json({
      success: true,
      cash: newCash,
      coin: newCoin,
      transferAmount: amountNpr,
      tipAmount,
      coinsReceived,
      transferId,
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
