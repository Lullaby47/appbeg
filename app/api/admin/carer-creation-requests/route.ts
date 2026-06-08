import { NextResponse } from 'next/server';

import { adminAuth, adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  getCarerCreationRequestSql,
  listPendingCarerCreationRequestsSql,
  mapFirestoreCarerCreationRequest,
  mirrorCarerCreationRequestById,
  updateCarerCreationRequestStatusSql,
  type CarerCreationRequestRecord,
} from '@/lib/sql/carerCreationRequestsCache';
import {
  createUserDirectoryInSql,
  isActiveUsernameTakenInSql,
} from '@/lib/sql/userDirectoryWrite';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

async function rollbackFirebaseUser(uid: string) {
  try {
    await adminAuth.deleteUser(uid);
  } catch {
    // Best-effort cleanup.
  }
}

async function getFirestorePendingRequests(): Promise<CarerCreationRequestRecord[]> {
  const snapshot = await adminDb
    .collection('carerCreationRequests')
    .where('status', '==', 'pending')
    .get();
  return snapshot.docs
    .map((docSnap) =>
      mapFirestoreCarerCreationRequest(docSnap.id, (docSnap.data() || {}) as Record<string, unknown>)
    )
    .sort((a, b) => {
      const aMs = a.requestedAt ? new Date(a.requestedAt).getTime() : 0;
      const bMs = b.requestedAt ? new Date(b.requestedAt).getTime() : 0;
      return bMs - aMs;
    });
}

async function resolveCarerCreationRequest(
  requestId: string
): Promise<CarerCreationRequestRecord | null> {
  const sqlRecord = await getCarerCreationRequestSql(requestId);
  if (sqlRecord) {
    return sqlRecord;
  }

  await mirrorCarerCreationRequestById(requestId);
  const hydrated = await getCarerCreationRequestSql(requestId);
  if (hydrated) {
    return hydrated;
  }

  const requestSnap = await adminDb.collection('carerCreationRequests').doc(requestId).get();
  if (!requestSnap.exists) {
    return null;
  }
  return mapFirestoreCarerCreationRequest(
    requestSnap.id,
    (requestSnap.data() || {}) as Record<string, unknown>
  );
}

async function mirrorFirestoreRequestStatus(
  requestId: string,
  update: {
    status: 'approved' | 'rejected';
    reviewedAt: Date;
    reviewedByUid: string;
    reviewedByUsername: string;
    createdCarerUid?: string | null;
    note?: string | null;
  }
) {
  const requestRef = adminDb.collection('carerCreationRequests').doc(requestId);
  await requestRef.update({
    status: update.status,
    reviewedAt: update.reviewedAt,
    reviewedByUid: update.reviewedByUid,
    reviewedByUsername: update.reviewedByUsername,
    ...(update.createdCarerUid ? { createdCarerUid: update.createdCarerUid } : {}),
    ...(update.note !== undefined ? { note: update.note } : {}),
  });
}

export async function GET(request: Request) {
  const startedAt = Date.now();

  try {
    const auth = await requireApiUser(request, ['admin']);
    if ('response' in auth) {
      return auth.response;
    }
    console.info('[ADMIN_CARER_CREATION_REQUESTS_AUTH]', {
      auth_path: auth.authPath,
      uid: auth.user.uid,
      app_session_used: auth.authPath.startsWith('app_session'),
    });

    let source: 'postgres' | 'firestore' = 'postgres';
    let requests = await listPendingCarerCreationRequestsSql();
    if (!requests || requests.length === 0) {
      source = 'firestore';
      requests = await getFirestorePendingRequests();
    }

    console.info('[CARER_CREATION_REQUEST_SQL]', {
      action: 'list_pending',
      requestId: '',
      coadminUid: '',
      sql_ok: source === 'postgres',
      firestore_mirror_ok: source === 'firestore',
      count: requests.length,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({ requests, source });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load requests.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let createdAuthUid: string | null = null;
  const startedAt = Date.now();
  let requestId = '';

  try {
    const auth = await requireApiUser(request, ['admin']);
    if ('response' in auth) {
      return auth.response;
    }
    const admin = {
      uid: auth.user.uid,
      username: auth.user.username || 'Admin',
    };
    console.info('[ADMIN_CARER_CREATION_REQUESTS_AUTH]', {
      auth_path: auth.authPath,
      uid: admin.uid,
      app_session_used: auth.authPath.startsWith('app_session'),
    });
    const body = (await request.json()) as {
      requestId?: string;
      password?: string;
      action?: 'approve' | 'reject';
    };
    requestId = String(body.requestId || '').trim();
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

    const requestRecord = await resolveCarerCreationRequest(requestId);
    if (!requestRecord) {
      return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
    }
    if (requestRecord.status !== 'pending') {
      return NextResponse.json({ error: 'Request already reviewed.' }, { status: 409 });
    }

    if (action === 'reject') {
      const sqlOk = await updateCarerCreationRequestStatusSql({
        requestId,
        status: 'rejected',
        reviewedByUid: admin.uid,
        reviewedByUsername: admin.username,
      });
      if (!sqlOk) {
        return NextResponse.json({ error: 'Failed to reject request in SQL.' }, { status: 500 });
      }

      let firestoreMirrorOk = false;
      try {
        await mirrorFirestoreRequestStatus(requestId, {
          status: 'rejected',
          reviewedAt: new Date(),
          reviewedByUid: admin.uid,
          reviewedByUsername: admin.username,
          note: null,
        });
        firestoreMirrorOk = true;
      } catch (error) {
        console.warn('[CARER_CREATION_REQUEST_SQL] firestore mirror failed', {
          action: 'reject',
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      console.info('[CARER_CREATION_REQUEST_SQL]', {
        action: 'reject',
        requestId,
        coadminUid: requestRecord.coadminUid,
        sql_ok: true,
        firestore_mirror_ok: firestoreMirrorOk,
        durationMs: Date.now() - startedAt,
      });

      return NextResponse.json({
        success: true,
        sqlOk: true,
        firestoreMirrorOk,
        message: 'Carer request rejected.',
      });
    }

    const requestedUsername = String(requestRecord.requestedUsername || '').trim().toLowerCase();
    const ownerCoadminUid = String(requestRecord.coadminUid || '').trim();
    if (!requestedUsername || !ownerCoadminUid) {
      return NextResponse.json({ error: 'Request payload is invalid.' }, { status: 400 });
    }

    const existingUserSnap = await adminDb
      .collection('users')
      .where('username', '==', requestedUsername)
      .limit(1)
      .get();
    if (!existingUserSnap.empty || (await isActiveUsernameTakenInSql(requestedUsername))) {
      const rejectionNote = 'Username already exists at approval time.';
      const sqlRejectOk = await updateCarerCreationRequestStatusSql({
        requestId,
        status: 'rejected',
        reviewedByUid: admin.uid,
        reviewedByUsername: admin.username,
        rejectionReason: rejectionNote,
      });

      let firestoreMirrorOk = false;
      try {
        await mirrorFirestoreRequestStatus(requestId, {
          status: 'rejected',
          reviewedAt: new Date(),
          reviewedByUid: admin.uid,
          reviewedByUsername: admin.username,
          note: rejectionNote,
        });
        firestoreMirrorOk = true;
      } catch (error) {
        console.warn('[CARER_CREATION_REQUEST_SQL] firestore mirror failed', {
          action: 'reject',
          requestId,
          reason: 'username_exists_auto_reject',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      console.info('[CARER_CREATION_REQUEST_SQL]', {
        action: 'reject',
        requestId,
        coadminUid: ownerCoadminUid,
        sql_ok: sqlRejectOk,
        firestore_mirror_ok: firestoreMirrorOk,
        durationMs: Date.now() - startedAt,
        reason: 'username_exists_at_approval',
      });

      return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
    }

    const email = makeHiddenEmail(requestedUsername);
    const approveStartedAt = Date.now();
    let firebaseCreateOk = false;

    const authUser = await adminAuth.createUser({
      email,
      password,
      displayName: requestedUsername,
      disabled: false,
    });
    createdAuthUid = authUser.uid;
    firebaseCreateOk = true;

    const carerUser = {
      uid: authUser.uid,
      username: requestedUsername,
      email,
      role: 'carer',
      createdBy: ownerCoadminUid,
      coadminUid: ownerCoadminUid,
      createdAt: new Date(),
      status: 'active',
    };

    try {
      await createUserDirectoryInSql({
        uid: authUser.uid,
        username: requestedUsername,
        email,
        role: 'carer',
        status: 'active',
        coadminUid: ownerCoadminUid,
        createdBy: ownerCoadminUid,
        password,
        rawData: carerUser,
        actorUid: admin.uid,
        actorRole: 'admin',
      });
    } catch (error) {
      await rollbackFirebaseUser(authUser.uid);
      createdAuthUid = null;
      console.info('[USER_DIRECTORY_SQL]', {
        action: 'create_user',
        route: 'approve_carer_request',
        uid: authUser.uid,
        role: 'carer',
        actorUid: admin.uid,
        sql_ok: false,
        firebase_create_ok: firebaseCreateOk,
        firestore_mirror_ok: false,
        durationMs: Date.now() - approveStartedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    let firestoreUserMirrorOk = false;
    try {
      await adminDb.collection('users').doc(authUser.uid).set(carerUser);
      firestoreUserMirrorOk = true;
      void mirrorUserBalanceSnapshotById(authUser.uid, 'appbeg_create_carer');
    } catch (error) {
      console.warn('[USER_DIRECTORY_SQL] firestore mirror failed', {
        action: 'create_user',
        route: 'approve_carer_request',
        uid: authUser.uid,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const sqlApproveOk = await updateCarerCreationRequestStatusSql({
      requestId,
      status: 'approved',
      reviewedByUid: admin.uid,
      reviewedByUsername: admin.username,
      createdCarerUid: authUser.uid,
    });
    if (!sqlApproveOk) {
      console.warn('[CARER_CREATION_REQUEST_SQL] approve status update failed after user create', {
        requestId,
        uid: authUser.uid,
      });
    }

    let firestoreRequestMirrorOk = false;
    try {
      await mirrorFirestoreRequestStatus(requestId, {
        status: 'approved',
        reviewedAt: new Date(),
        reviewedByUid: admin.uid,
        reviewedByUsername: admin.username,
        createdCarerUid: authUser.uid,
        note: null,
      });
      firestoreRequestMirrorOk = true;
    } catch (error) {
      console.warn('[CARER_CREATION_REQUEST_SQL] firestore mirror failed', {
        action: 'approve',
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    createdAuthUid = null;

    console.info('[USER_DIRECTORY_SQL]', {
      action: 'create_user',
      route: 'approve_carer_request',
      uid: authUser.uid,
      role: 'carer',
      actorUid: admin.uid,
      sql_ok: true,
      firebase_create_ok: firebaseCreateOk,
      firestore_mirror_ok: firestoreUserMirrorOk,
      durationMs: Date.now() - approveStartedAt,
    });

    console.info('[CARER_CREATION_REQUEST_SQL]', {
      action: 'approve',
      requestId,
      coadminUid: ownerCoadminUid,
      sql_ok: sqlApproveOk,
      firestore_mirror_ok: firestoreRequestMirrorOk,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      success: true,
      uid: authUser.uid,
      message: 'Carer created after admin approval.',
      sqlOk: true,
      firebaseMirrorOk: firebaseCreateOk,
      firestoreMirrorOk: firestoreUserMirrorOk,
      requestSqlOk: sqlApproveOk,
      requestFirestoreMirrorOk: firestoreRequestMirrorOk,
    });
  } catch (error) {
    if (createdAuthUid) {
      try {
        await rollbackFirebaseUser(createdAuthUid);
      } catch {
        // Best-effort cleanup.
      }
    }
    const message = error instanceof Error ? error.message : 'Failed to process request.';
    const status = message.includes('not found') ? 404 : 500;
    console.info('[CARER_CREATION_REQUEST_SQL]', {
      action: 'approve',
      requestId,
      coadminUid: '',
      sql_ok: false,
      firestore_mirror_ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
