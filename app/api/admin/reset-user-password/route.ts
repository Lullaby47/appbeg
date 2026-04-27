import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

type AllowedRole = 'admin' | 'staff' | 'coadmin';

function isAllowedRole(role: string): role is AllowedRole {
  return role === 'admin' || role === 'staff' || role === 'coadmin';
}

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
    if (callerRole !== 'admin') {
      return NextResponse.json({ error: 'Only admin can reset these passwords.' }, { status: 403 });
    }

    const body = (await request.json()) as {
      targetUid?: string;
      newPassword?: string;
    };
    const targetUid = String(body.targetUid || '').trim();
    const newPassword = String(body.newPassword || '');
    if (!targetUid) {
      return NextResponse.json({ error: 'targetUid is required.' }, { status: 400 });
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
    }

    const targetSnap = await adminDb.collection('users').doc(targetUid).get();
    if (!targetSnap.exists) {
      return NextResponse.json({ error: 'Target user not found.' }, { status: 404 });
    }
    const targetRole = String(targetSnap.data()?.role || '').toLowerCase();
    if (!isAllowedRole(targetRole)) {
      return NextResponse.json(
        { error: 'Admin can only reset admin, staff, or coadmin password.' },
        { status: 403 }
      );
    }

    await adminAuth.updateUser(targetUid, { password: newPassword });
    return NextResponse.json({ success: true, message: 'Password reset successfully.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Password reset failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
