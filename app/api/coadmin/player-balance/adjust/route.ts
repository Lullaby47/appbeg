import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';

type Body = {
  playerUid?: unknown;
  delta?: unknown;
  balanceType?: unknown;
};

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['coadmin', 'staff', 'admin']);
    if ('response' in auth) return auth.response;
    const body = (await request.json()) as Body;
    const playerUid = String(body.playerUid || '').trim();
    const delta = Number(body.delta);
    const balanceType = String(body.balanceType || '').trim().toLowerCase();
    if (!playerUid) return apiError('playerUid is required.', 400);
    if (!Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta)) {
      return apiError('Amount must be a non-zero whole number.', 400);
    }
    if (balanceType !== 'coin' && balanceType !== 'cash') {
      return apiError("balanceType must be 'coin' or 'cash'.", 400);
    }

    const scope = scopedCoadminUid(auth.user);
    const playerRef = adminDb.collection('users').doc(playerUid);
    await adminDb.runTransaction(async (transaction) => {
      const playerSnap = await transaction.get(playerRef);
      if (!playerSnap.exists) throw new Error('Player not found.');
      const player = playerSnap.data() as {
        role?: string;
        coin?: number;
        cash?: number;
        coadminUid?: string | null;
        createdBy?: string | null;
      };
      if (String(player.role || '').toLowerCase() !== 'player') {
        throw new Error('This account is not a player.');
      }
      const playerScope =
        String(player.coadminUid || '').trim() || String(player.createdBy || '').trim();
      if (auth.user.role !== 'admin' && playerScope !== scope) {
        throw new Error('Forbidden: this player is outside your scope.');
      }

      const current =
        balanceType === 'coin'
          ? Math.max(0, Math.floor(Number(player.coin || 0)))
          : Math.max(0, Math.floor(Number(player.cash || 0)));
      const next = current + delta;
      if (next < 0) {
        throw new Error(
          balanceType === 'coin'
            ? 'Not enough coin to deduct that amount.'
            : 'Not enough cash to deduct that amount.'
        );
      }

      transaction.update(playerRef, { [balanceType]: next });
      transaction.set(adminDb.collection('financialEvents').doc(), {
        playerUid,
        coadminUid: playerScope,
        amountNpr: Math.abs(delta),
        type:
          balanceType === 'coin'
            ? delta > 0
              ? 'coadmin_coin_add'
              : 'coadmin_coin_deduct'
            : delta > 0
              ? 'coadmin_cash_add'
              : 'coadmin_cash_deduct',
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to adjust player balance.';
    const status = /not authenticated|authorization|token/i.test(message) ? 401 : /forbidden|scope/i.test(message) ? 403 : /required|not found|not enough|whole|player/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}

