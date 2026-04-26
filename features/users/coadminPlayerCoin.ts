import { runTransaction, doc } from 'firebase/firestore';

import { db } from '@/lib/firebase/client';
import { belongsToCoadmin, getCurrentUserCoadminUid } from '@/lib/coadmin/scope';
import { recordFinancialEventAndRefreshRisk } from '@/features/risk/playerRisk';

/**
 * Add or remove whole-number coin for a player in the current user’s coadmin scope.
 * Callers may be a **coadmin** or **staff**; scope is resolved the same way as other
 * player tools (parent coadmin). Deductions cannot make coin negative.
 */
export async function adjustPlayerCoin({
  playerUid,
  delta,
}: {
  playerUid: string;
  delta: number;
}) {
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('Amount must be a non-zero number.');
  }

  if (!Number.isInteger(delta)) {
    throw new Error('Use whole numbers only (no decimals).');
  }

  const coadminUid = await getCurrentUserCoadminUid();
  const playerRef = doc(db, 'users', playerUid);

  await runTransaction(db, async (transaction) => {
    const playerSnap = await transaction.get(playerRef);

    if (!playerSnap.exists()) {
      throw new Error('Player not found.');
    }

    const data = playerSnap.data() as {
      role?: string;
      coin?: number;
      coadminUid?: string | null;
      createdBy?: string | null;
    };

    if (String(data.role || '').toLowerCase() !== 'player') {
      throw new Error('This account is not a player.');
    }

    if (!belongsToCoadmin(data, coadminUid)) {
      throw new Error('This player is not in your scope.');
    }

    const current = Math.max(0, Math.floor(Number(data.coin || 0)));
    const next = current + delta;

    if (next < 0) {
      throw new Error('Not enough coin to deduct that amount.');
    }

    transaction.update(playerRef, { coin: next });
  });

  const absAmount = Math.abs(delta);
  try {
    await recordFinancialEventAndRefreshRisk({
      playerUid,
      coadminUid,
      amountNpr: absAmount,
      type: delta > 0 ? 'coadmin_coin_add' : 'coadmin_coin_deduct',
    });
  } catch (err) {
    console.error('adjustPlayerCoin: balance updated but activity log / risk failed', err);
  }
}

/** @deprecated Use `adjustPlayerCoin` — same behavior, kept for older imports. */
export const adjustPlayerCoinByCoadmin = adjustPlayerCoin;
