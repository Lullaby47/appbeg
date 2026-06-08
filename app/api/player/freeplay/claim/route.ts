import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorFreeplayPendingGiftByPlayerUid } from '@/lib/sql/freeplayPendingGiftsCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) return auth.response;

    const body = (await request.json().catch(() => ({}))) as { giftId?: unknown };
    const requestedGiftId = String(body.giftId || '').trim();
    if (!requestedGiftId) {
      return NextResponse.json({ error: 'FreePlay gift id is required.' }, { status: 400 });
    }

    const playerUid = auth.user.uid;
    const playerRef = adminDb.collection('users').doc(playerUid);
    const markerRef = adminDb.collection('freeplayPendingGifts').doc(playerUid);
    const eventRef = adminDb.collection('financialEvents').doc();
    let amount = 0;
    let alreadyClaimed = false;
    let mirroredEventId = '';

    await adminDb.runTransaction(async (transaction) => {
      const markerSnap = await transaction.get(markerRef);
      if (!markerSnap.exists) {
        throw new Error('No pending FreePlay gift found.');
      }
      const marker = markerSnap.data() as {
        type?: string;
        status?: string;
        giftId?: string;
        amount?: number | null;
        coadminUid?: string | null;
      };
      if (String(marker.type || '').toLowerCase() !== 'freeplay') {
        throw new Error('No pending FreePlay gift found.');
      }
      if (String(marker.giftId || '').trim() !== requestedGiftId) {
        throw new Error('This FreePlay gift is no longer pending.');
      }
      if (String(marker.status || '').toLowerCase() === 'claimed') {
        amount = Number(marker.amount || 0);
        alreadyClaimed = true;
        return;
      }
      if (String(marker.status || '').toLowerCase() !== 'pending' || !marker.giftId) {
        throw new Error('No pending FreePlay gift found.');
      }

      const giftRef = adminDb.collection('freeplayGifts').doc(requestedGiftId);
      const [giftSnap, playerSnap] = await Promise.all([
        transaction.get(giftRef),
        transaction.get(playerRef),
      ]);
      if (!giftSnap.exists || !playerSnap.exists) {
        throw new Error('FreePlay gift or player profile not found.');
      }
      const gift = giftSnap.data() as {
        playerUid?: string;
        type?: string;
        status?: string;
        coadminUid?: string | null;
      };
      if (
        String(gift.playerUid || '').trim() !== playerUid ||
        String(gift.type || '').toLowerCase() !== 'freeplay' ||
        String(gift.status || '').toLowerCase() !== 'pending'
      ) {
        throw new Error('No pending FreePlay gift found.');
      }
      const player = playerSnap.data() as { role?: string; coin?: number };
      if (String(player.role || '').toLowerCase() !== 'player') {
        throw new Error('Only players can claim FreePlay gifts.');
      }

      amount = Math.random() < 0.5 ? 2 : 3;
      const claimedFields = {
        status: 'claimed',
        amount,
        claimedAt: FieldValue.serverTimestamp(),
      };
      transaction.update(giftRef, claimedFields);
      transaction.update(markerRef, claimedFields);
      transaction.update(playerRef, {
        coin: Math.max(0, Number(player.coin || 0)) + amount,
      });
      transaction.set(eventRef, {
        type: 'freeplay',
        playerUid,
        coadminUid: String(gift.coadminUid || marker.coadminUid || '').trim() || null,
        amountNpr: amount,
        giftId: giftRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
      mirroredEventId = eventRef.id;
    });

    if (mirroredEventId) {
      void mirrorFinancialEventById(mirroredEventId, 'appbeg_freeplay_claim');
      void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_freeplay_claim');
    }
    void mirrorFreeplayPendingGiftByPlayerUid(playerUid, 'appbeg_freeplay_claim').then((mirrorOk) => {
      console.info('[FREEPLAY_PENDING_CACHE]', {
        source: 'firestore_write',
        playerUid,
        mirror_ok: mirrorOk,
        action: 'claim',
        alreadyClaimed,
      });
    });
    return NextResponse.json({
      success: true,
      amount,
      alreadyClaimed,
      message: `You got ${amount} FreePlay coins!`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to claim FreePlay gift.';
    return NextResponse.json(
      { error: message },
      {
        status: /authorization|token|logged out/i.test(message)
          ? 401
          : /only players/i.test(message)
            ? 403
            : 400,
      }
    );
  }
}
