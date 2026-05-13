import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';

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

    return NextResponse.json({ success: true, message: 'Player transferred successfully.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Player transfer failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
