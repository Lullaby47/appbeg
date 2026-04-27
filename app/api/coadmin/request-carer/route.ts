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
    const callerSnap = await adminDb.collection('users').doc(decoded.uid).get();
    if (!callerSnap.exists) {
      return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
    }

    const callerData = callerSnap.data() as { role?: string; username?: string; coadminUid?: string };
    const callerRole = String(callerData.role || '').toLowerCase();
    if (callerRole !== 'coadmin') {
      return NextResponse.json({ error: 'Only coadmin can request carer creation.' }, { status: 403 });
    }

    const body = (await request.json()) as { username?: string };
    const requestedUsername = String(body.username || '').trim().toLowerCase();
    if (!requestedUsername) {
      return NextResponse.json({ error: 'Username is required.' }, { status: 400 });
    }

    const existsSnap = await adminDb
      .collection('users')
      .where('username', '==', requestedUsername)
      .limit(1)
      .get();
    if (!existsSnap.empty) {
      return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
    }

    const pendingSnap = await adminDb
      .collection('carerCreationRequests')
      .where('coadminUid', '==', decoded.uid)
      .where('requestedUsername', '==', requestedUsername)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    if (!pendingSnap.empty) {
      return NextResponse.json({ error: 'This carer request is already pending approval.' }, { status: 409 });
    }

    const requestRef = adminDb.collection('carerCreationRequests').doc();
    await requestRef.set({
      coadminUid: decoded.uid,
      coadminUsername: String(callerData.username || 'Coadmin'),
      requestedUsername,
      status: 'pending',
      requestedAt: new Date(),
      reviewedAt: null,
      reviewedByUid: null,
      reviewedByUsername: null,
      createdCarerUid: null,
      note: null,
    });

    return NextResponse.json({
      success: true,
      requestId: requestRef.id,
      message: 'Carer request submitted for admin approval.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to request carer creation.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

