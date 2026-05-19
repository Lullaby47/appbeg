import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { getCoadminMaintenanceBreak, maintenanceBreakApiResponse } from '@/lib/maintenance/admin';

type Body = {
  amountNpr?: unknown;
};

function parsePositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed !== Math.floor(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body;
    const amountNpr = parsePositiveInteger(body.amountNpr);
    if (!amountNpr) {
      return apiError('Amount must be a positive whole number.', 400);
    }

    const playerUid = auth.user.uid;
    const playerRef = adminDb.collection('users').doc(playerUid);
    let newCash = 0;
    let newCoin = 0;

    await adminDb.runTransaction(async (transaction) => {
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
      newCoin = currentCoin + amountNpr;

      transaction.update(playerRef, {
        cash: newCash,
        coin: newCoin,
      });

      const eventRef = adminDb.collection('financialEvents').doc();
      transaction.set(eventRef, {
        playerUid,
        coadminUid,
        amountNpr,
        type: 'transfer',
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return NextResponse.json({ success: true, cash: newCash, coin: newCoin });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to transfer cash to coin.';
    if (message.startsWith('MAINTENANCE_BREAK:')) {
      return maintenanceBreakApiResponse(message.replace(/^MAINTENANCE_BREAK:/, ''));
    }
    const status = /not authenticated|authorization|token/i.test(message)
      ? 401
      : /forbidden|blocked/i.test(message)
      ? 403
      : /required|valid|not found|only|amount|cash|transfer/i.test(message)
      ? 400
      : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
