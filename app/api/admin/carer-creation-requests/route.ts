import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

async function requireAdmin(request: Request) {
  const header = request.headers.get('Authorization') || '';
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) {
    throw new Error('Missing or invalid authorization.');
  }

  const decoded = await adminAuth.verifyIdToken(token);
  const callerSnap = await adminDb.collection('users').doc(decoded.uid).get();
  if (!callerSnap.exists) {
    throw new Error('User profile not found.');
  }
  const callerData = callerSnap.data() as { role?: string; username?: string };
  const role = String(callerData.role || '').toLowerCase();
  if (role !== 'admin') {
    throw new Error('Only admin can perform this action.');
  }
  return {
    uid: decoded.uid,
    username: String(callerData.username || 'Admin'),
  };
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);

    const snapshot = await adminDb
      .collection('carerCreationRequests')
      .where('status', '==', 'pending')
      .get();
    const requests = snapshot.docs
      .map(
        (docSnap) =>
          ({ id: docSnap.id, ...(docSnap.data() as Record<string, unknown>) }) as {
            id: string;
            requestedAt?: { toDate?: () => Date };
          } & Record<string, unknown>
      )
      .sort((a, b) => {
        const aMs = a.requestedAt?.toDate?.()?.getTime?.() || 0;
        const bMs = b.requestedAt?.toDate?.()?.getTime?.() || 0;
        return bMs - aMs;
      });

    return NextResponse.json({ requests });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load requests.';
    const status = message.includes('authorization') || message.includes('Only admin') ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  let createdAuthUid: string | null = null;
  try {
    const admin = await requireAdmin(request);
    const body = (await request.json()) as {
      requestId?: string;
      password?: string;
      action?: 'approve' | 'reject';
    };
    const requestId = String(body.requestId || '').trim();
    const action = String(body.action || 'approve').trim().toLowerCase();
    const password = String(body.password || '');

    if (!requestId) {
      return NextResponse.json({ error: 'requestId is required.' }, { status: 400 });
    }
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'Invalid action.' }, { status: 400 });
    }
    if (action === 'approve' && password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
    }

    const requestRef = adminDb.collection('carerCreationRequests').doc(requestId);
    const requestSnap = await requestRef.get();
    if (!requestSnap.exists) {
      return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
    }
    const requestData = requestSnap.data() as {
      coadminUid?: string;
      requestedUsername?: string;
      status?: string;
    };
    if (String(requestData.status || '') !== 'pending') {
      return NextResponse.json({ error: 'Request already reviewed.' }, { status: 409 });
    }

    if (action === 'reject') {
      await requestRef.update({
        status: 'rejected',
        reviewedAt: new Date(),
        reviewedByUid: admin.uid,
        reviewedByUsername: admin.username,
      });
      return NextResponse.json({ success: true, message: 'Carer request rejected.' });
    }

    const requestedUsername = String(requestData.requestedUsername || '').trim().toLowerCase();
    const ownerCoadminUid = String(requestData.coadminUid || '').trim();
    if (!requestedUsername || !ownerCoadminUid) {
      return NextResponse.json({ error: 'Request payload is invalid.' }, { status: 400 });
    }

    const existingUserSnap = await adminDb
      .collection('users')
      .where('username', '==', requestedUsername)
      .limit(1)
      .get();
    if (!existingUserSnap.empty) {
      await requestRef.update({
        status: 'rejected',
        note: 'Username already exists at approval time.',
        reviewedAt: new Date(),
        reviewedByUid: admin.uid,
        reviewedByUsername: admin.username,
      });
      return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
    }

    const email = makeHiddenEmail(requestedUsername);
    const authUser = await adminAuth.createUser({
      email,
      password,
      displayName: requestedUsername,
      disabled: false,
    });
    createdAuthUid = authUser.uid;

    await adminDb.collection('users').doc(authUser.uid).set({
      uid: authUser.uid,
      username: requestedUsername,
      email,
      role: 'carer',
      createdBy: ownerCoadminUid,
      coadminUid: ownerCoadminUid,
      createdAt: new Date(),
      status: 'active',
    });

    await requestRef.update({
      status: 'approved',
      reviewedAt: new Date(),
      reviewedByUid: admin.uid,
      reviewedByUsername: admin.username,
      createdCarerUid: authUser.uid,
      note: null,
    });
    createdAuthUid = null;

    return NextResponse.json({
      success: true,
      uid: authUser.uid,
      message: 'Carer created after admin approval.',
    });
  } catch (error) {
    if (createdAuthUid) {
      try {
        await adminAuth.deleteUser(createdAuthUid);
      } catch {
        // Best-effort cleanup.
      }
    }
    const message = error instanceof Error ? error.message : 'Failed to process request.';
    const status =
      message.includes('authorization') || message.includes('Only admin')
        ? 403
        : message.includes('not found')
          ? 404
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

