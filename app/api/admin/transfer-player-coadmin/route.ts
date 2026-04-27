import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

export async function POST(request: Request) {
  try {
    const header = request.headers.get('Authorization') || '';
    const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) {
      return NextResponse.json({ error: 'Missing or invalid authorization.' }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(token);
    const callerUid = decoded.uid;
    const callerSnap = await adminDb.collection('users').doc(callerUid).get();
    if (!callerSnap.exists) {
      return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
    }
    const callerRole = String(callerSnap.data()?.role || '').toLowerCase();
    if (callerRole !== 'admin' && callerRole !== 'staff') {
      return NextResponse.json(
        { error: 'Only admin or staff can transfer players between coadmins.' },
        { status: 403 }
      );
    }

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
        transferredByUid: callerUid,
      },
      { merge: true }
    );

    return NextResponse.json({ success: true, message: 'Player transferred successfully.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Player transfer failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
