import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { transferPlayerCoadminInSql } from '@/lib/sql/authorityAdminPlayer';
import { mirrorPlayerById } from '@/lib/sql/playersCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as {
      playerUid?: string;
      targetCoadminUid?: string;
    };
    const playerUid = String(body.playerUid || '').trim();
    const targetCoadminUid = String(body.targetCoadminUid || '').trim();
    if (!playerUid || !targetCoadminUid) {
      return NextResponse.json(
        { error: 'playerUid and targetCoadminUid are required.' },
        { status: 400 }
      );
    }

    if (isAuthoritySqlWriteEnabled()) {
      const result = await transferPlayerCoadminInSql({
        playerUid,
        targetCoadminUid,
        actorUid: auth.user.uid,
      });
      logAuthoritySqlWrite('/api/admin/transfer-player-coadmin', result);
      return NextResponse.json({
        authority: 'sql',
        ...result,
        message: 'Player transferred successfully.',
      });
    }

    const [playerSnap, coadminSnap] = await Promise.all([
      adminDb.collection('users').doc(playerUid).get(),
      adminDb.collection('users').doc(targetCoadminUid).get(),
    ]);
    if (!playerSnap.exists) {
      return NextResponse.json({ error: 'Player not found.' }, { status: 404 });
    }
    if (!coadminSnap.exists || String(coadminSnap.data()?.role || '').toLowerCase() !== 'coadmin') {
      return NextResponse.json({ error: 'Target coadmin is invalid.' }, { status: 400 });
    }
    if (String(playerSnap.data()?.role || '').toLowerCase() !== 'player') {
      return NextResponse.json({ error: 'Target user is not a player.' }, { status: 400 });
    }

    await adminDb.collection('users').doc(playerUid).set(
      {
        coadminUid: targetCoadminUid,
        createdBy: targetCoadminUid,
        updatedAt: new Date(),
        transferredByUid: auth.user.uid,
      },
      { merge: true }
    );
    void mirrorPlayerById(playerUid, 'appbeg_transfer_player_coadmin');
    void mirrorUserBalanceSnapshotById(playerUid, 'appbeg_transfer_player_coadmin');

    return NextResponse.json({ success: true, message: 'Player transferred successfully.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Player transfer failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
