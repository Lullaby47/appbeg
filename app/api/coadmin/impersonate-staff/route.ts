import type { DocumentData } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

function staffBelongsToCoadmin(data: DocumentData, coadminUid: string) {
  return String(data.coadminUid || '') === coadminUid || String(data.createdBy || '') === coadminUid;
}

export async function POST(request: Request) {
  try {
    const header = request.headers.get('Authorization') || '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    const idToken = match?.[1];
    if (!idToken) {
      return NextResponse.json({ error: 'Missing or invalid authorization.' }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(idToken);
    const callerUid = decoded.uid;
    const callerSnap = await adminDb.collection('users').doc(callerUid).get();
    if (!callerSnap.exists) {
      return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
    }
    const callerData = callerSnap.data() as { role?: string; username?: string };
    if (String(callerData.role || '').toLowerCase() !== 'coadmin') {
      return NextResponse.json({ error: 'Only coadmin can impersonate staff.' }, { status: 403 });
    }

    const body = (await request.json()) as { staffUid?: string };
    const staffUid = String(body.staffUid || '').trim();
    if (!staffUid) {
      return NextResponse.json({ error: 'staffUid is required.' }, { status: 400 });
    }

    const staffRef = adminDb.collection('users').doc(staffUid);
    const staffSnap = await staffRef.get();
    if (!staffSnap.exists) {
      return NextResponse.json({ error: 'Staff account not found.' }, { status: 404 });
    }
    const staffData = staffSnap.data() as { role?: string; username?: string };
    if (String(staffData.role || '').toLowerCase() !== 'staff') {
      return NextResponse.json({ error: 'Target account must be staff.' }, { status: 403 });
    }
    if (!staffBelongsToCoadmin(staffSnap.data() || {}, callerUid)) {
      return NextResponse.json({ error: 'Staff is outside your coadmin scope.' }, { status: 403 });
    }

    const customToken = await adminAuth.createCustomToken(staffUid, {
      impersonatedByUid: callerUid,
      impersonatedByRole: 'coadmin',
      impersonation: true,
    });

    await adminDb.collection('impersonationLogs').add({
      coadminUid: callerUid,
      coadminUsername: String(callerData.username || 'Coadmin'),
      staffUid,
      staffUsername: String(staffData.username || 'Staff'),
      createdAt: FieldValue.serverTimestamp(),
      source: 'coadmin_behaviours',
    });

    return NextResponse.json({
      success: true,
      customToken,
      redirectTo: '/staff',
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to impersonate staff.' },
      { status: 500 }
    );
  }
}

