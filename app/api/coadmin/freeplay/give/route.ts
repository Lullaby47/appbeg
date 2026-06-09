import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  authoritySqlWriteEnvLogFields,
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { giveFreeplayGiftInSql } from '@/lib/sql/authorityFreeplay';
import { getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';
import { mirrorFreeplayPendingGiftByPlayerUid } from '@/lib/sql/freeplayPendingGiftsCache';

const ROUTE = '/api/coadmin/freeplay/give';

type PlayerCandidate = {
  uid: string;
  username: string;
};

function isEligiblePlayer(data: Record<string, unknown>) {
  return (
    String(data.role || '').toLowerCase() === 'player' &&
    String(data.status || '').toLowerCase() !== 'disabled'
  );
}

async function loadPlayersForCoadmin(coadminUid: string): Promise<PlayerCandidate[]> {
  const [scopedSnap, legacySnap] = await Promise.all([
    adminDb.collection('users').where('coadminUid', '==', coadminUid).get(),
    adminDb.collection('users').where('createdBy', '==', coadminUid).get(),
  ]);
  const players = new Map<string, PlayerCandidate>();

  [...scopedSnap.docs, ...legacySnap.docs].forEach((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    if (!isEligiblePlayer(data)) {
      return;
    }
    players.set(docSnap.id, {
      uid: docSnap.id,
      username: String(data.username || '').trim() || 'Player',
    });
  });

  return [...players.values()];
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const auth = await requireApiUser(request, ['coadmin']);
    if ('response' in auth) return auth.response;

    const coadminUid = auth.user.uid;
    const body = (await request.json().catch(() => ({}))) as { idempotencyKey?: unknown };
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    if (isAuthoritySqlWriteEnabled()) {
      const result = await giveFreeplayGiftInSql({ coadminUid, idempotencyKey });
      const poolStats = getPlayerMirrorPoolStats();

      logAuthoritySqlWrite(ROUTE, {
        ...authoritySqlWriteEnvLogFields(),
        coadminUid,
        playerUid: result.playerUid,
        giftId: result.giftId,
        duplicate: result.duplicate,
        route: ROUTE,
        pool_totalCount: poolStats?.totalCount ?? null,
        pool_idleCount: poolStats?.idleCount ?? null,
        pool_waitingCount: poolStats?.waitingCount ?? null,
        pool_max: poolStats?.max ?? null,
        duration_ms: Date.now() - startedAt,
      });

      return NextResponse.json({
        success: true,
        playerUsername: result.playerUsername,
        giftId: result.giftId,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    const players = await loadPlayersForCoadmin(coadminUid);
    if (players.length === 0) {
      return apiError('No active players are assigned to your account.', 400);
    }

    const pendingStates = await Promise.all(
      players.map(async (player) => {
        const markerSnap = await adminDb.collection('freeplayPendingGifts').doc(player.uid).get();
        const status = markerSnap.exists
          ? String((markerSnap.data() as { status?: string }).status || '').toLowerCase()
          : '';
        return status === 'pending' ? player.uid : null;
      })
    );
    const pendingPlayerUids = new Set(pendingStates.filter((uid): uid is string => Boolean(uid)));
    const eligiblePlayers = players.filter((player) => !pendingPlayerUids.has(player.uid));
    if (eligiblePlayers.length === 0) {
      return apiError('Every eligible player already has a pending FreePlay gift.', 409);
    }

    const selectedPlayer =
      eligiblePlayers[Math.floor(Math.random() * eligiblePlayers.length)];
    const playerRef = adminDb.collection('users').doc(selectedPlayer.uid);
    const giftRef = adminDb.collection('freeplayGifts').doc();
    const markerRef = adminDb.collection('freeplayPendingGifts').doc(selectedPlayer.uid);

    await adminDb.runTransaction(async (transaction) => {
      const [playerSnap, markerSnap] = await Promise.all([
        transaction.get(playerRef),
        transaction.get(markerRef),
      ]);
      if (!playerSnap.exists) {
        throw new Error('Selected player no longer exists.');
      }
      const playerData = playerSnap.data() as Record<string, unknown>;
      const belongsToCoadmin =
        String(playerData.coadminUid || '').trim() === coadminUid ||
        String(playerData.createdBy || '').trim() === coadminUid;
      if (!belongsToCoadmin || !isEligiblePlayer(playerData)) {
        throw new Error('Selected player is no longer eligible.');
      }
      if (
        markerSnap.exists &&
        String((markerSnap.data() as { status?: string }).status || '').toLowerCase() ===
          'pending'
      ) {
        throw new Error('This player already has a pending FreePlay gift.');
      }

      const gift = {
        type: 'freeplay',
        status: 'pending',
        coadminUid,
        playerUid: selectedPlayer.uid,
        createdAt: FieldValue.serverTimestamp(),
        claimedAt: null,
        amount: null,
      };
      transaction.set(giftRef, gift);
      transaction.set(markerRef, {
        ...gift,
        giftId: giftRef.id,
      });
    });

    void mirrorFreeplayPendingGiftByPlayerUid(
      selectedPlayer.uid,
      'coadmin_freeplay_give'
    ).then((mirrorOk) => {
      console.info('[FREEPLAY_PENDING_CACHE]', {
        source: 'firestore_write',
        playerUid: selectedPlayer.uid,
        mirror_ok: mirrorOk,
        action: 'give',
      });
    });

    return NextResponse.json({
      success: true,
      playerUsername: selectedPlayer.username,
      authority: 'firestore',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to give FreePlay gift.';
    const status = /authorization|token/i.test(message)
      ? 401
      : /forbidden/i.test(message)
        ? 403
        : /pending/i.test(message)
          ? 409
          : /player|eligible|active/i.test(message)
            ? 400
            : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
