import { NextResponse } from 'next/server';

import { adminAuth } from '@/lib/firebase/adminAuth';
import { lookupAppSessionWithClient } from '@/lib/sql/appSessions';
import {
  getCarerCreationRequestSql,
  listPendingCarerCreationRequestsSql,
  updateCarerCreationRequestStatusSql,
} from '@/lib/sql/carerCreationRequestsCache';
import { acquirePlayerMirrorClient, cleanText } from '@/lib/sql/playerMirrorCommon';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';
import {
  createUserDirectoryInSql,
  isActiveUsernameTakenInSql,
} from '@/lib/sql/userDirectoryWrite';

export const runtime = 'nodejs';

const ROUTE = '/api/admin/carer-creation-requests';

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

async function requireAdminSqlAppSession(request: Request) {
  const sessionId = cleanText(request.headers.get('X-App-Session-Id'));
  if (!sessionId) {
    return {
      response: NextResponse.json(
        { error: 'App session required.', reason: 'app_session_required' },
        { status: 401 }
      ),
    } as const;
  }

  const acquired = await acquirePlayerMirrorClient({
    context: 'admin_carer_creation_requests_auth',
    route: ROUTE,
  });
  if (!acquired) {
    return {
      response: NextResponse.json(
        { error: 'SQL authority required for admin auth.', reason: 'postgres_unavailable' },
        { status: 503 }
      ),
    } as const;
  }

  let session;
  let profileLookup;
  try {
    session = await lookupAppSessionWithClient(sessionId, acquired.client);
    if (!session) {
      return {
        response: NextResponse.json(
          { error: 'Invalid or expired app session.', reason: 'app_session_invalid' },
          { status: 401 }
        ),
      } as const;
    }

    profileLookup = await lookupApiUserProfileFromSqlCache(session.uid, acquired.client);
  } finally {
    acquired.client.release();
  }

  const profile = profileLookup.profile;
  if (!profile) {
    return {
      response: NextResponse.json(
        { error: 'Admin profile not found in SQL.', reason: profileLookup.missReason },
        { status: 401 }
      ),
    } as const;
  }

  if (profile.role !== 'admin') {
    return {
      response: NextResponse.json(
        { error: 'Admin access required.', reason: 'role_not_allowed' },
        { status: 403 }
      ),
    } as const;
  }

  if (profile.status && profile.status !== 'active') {
    return {
      response: NextResponse.json(
        { error: 'Admin account is not active.', reason: 'account_not_active' },
        { status: 403 }
      ),
    } as const;
  }

  console.info('[ADMIN_CARER_CREATION_REQUESTS_AUTH]', {
    auth_path: 'app_session_sql',
    uid: profile.uid,
    app_session_used: true,
  });

  return {
    user: {
      uid: profile.uid,
      username: profile.username || 'Admin',
    },
    authPath: 'app_session_sql' as const,
  };
}

async function rollbackFirebaseUser(uid: string) {
  try {
    await adminAuth.deleteUser(uid);
  } catch {
    // Best-effort cleanup.
  }
}

function logFirestoreRemoved(method: string) {
  console.info('[ADMIN_CARER_CREATION_REQUESTS_FIRESTORE_REMOVED]', {
    route: ROUTE,
    method,
  });
}

export async function GET(request: Request) {
  const startedAt = Date.now();

  try {
    const auth = await requireAdminSqlAppSession(request);
    if ('response' in auth) {
      return auth.response;
    }
    logFirestoreRemoved('GET');

    const requests = await listPendingCarerCreationRequestsSql();
    if (!requests) {
      console.warn('[ADMIN_CARER_CREATION_REQUESTS_SQL]', {
        count: 0,
        source: 'sql_unavailable',
        firestore_fallback: false,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        {
          ok: false,
          error: 'SQL authority required for carer creation requests.',
          requests: [],
          source: 'sql_unavailable',
          firestore_fallback: false,
        },
        { status: 503 }
      );
    }

    console.info('[ADMIN_CARER_CREATION_REQUESTS_SQL]', {
      action: 'list_pending',
      count: requests.length,
      source: requests.length > 0 ? 'sql' : 'sql_empty',
      firestore_fallback: false,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ok: true,
      requests,
      source: requests.length > 0 ? 'sql' : 'sql_empty',
      firestore_fallback: false,
    });
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
    const auth = await requireAdminSqlAppSession(request);
    if ('response' in auth) {
      return auth.response;
    }
    const admin = {
      uid: auth.user.uid,
      username: auth.user.username || 'Admin',
    };
    logFirestoreRemoved('POST');
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

    const requestRecord = await getCarerCreationRequestSql(requestId);
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

      console.info('[ADMIN_CARER_CREATION_REQUESTS_SQL]', {
        action: 'reject',
        requestId,
        coadminUid: requestRecord.coadminUid,
        sql_ok: true,
        firestore_fallback: false,
        durationMs: Date.now() - startedAt,
      });

      return NextResponse.json({
        success: true,
        sqlOk: true,
        firestoreMirrorOk: false,
        firestore_fallback: false,
        source: 'sql',
        message: 'Carer request rejected.',
      });
    }

    const requestedUsername = String(requestRecord.requestedUsername || '').trim().toLowerCase();
    const ownerCoadminUid = String(requestRecord.coadminUid || '').trim();
    if (!requestedUsername || !ownerCoadminUid) {
      return NextResponse.json({ error: 'Request payload is invalid.' }, { status: 400 });
    }

    if (await isActiveUsernameTakenInSql(requestedUsername)) {
      const rejectionNote = 'Username already exists at approval time.';
      const sqlRejectOk = await updateCarerCreationRequestStatusSql({
        requestId,
        status: 'rejected',
        reviewedByUid: admin.uid,
        reviewedByUsername: admin.username,
        rejectionReason: rejectionNote,
      });

      console.info('[ADMIN_CARER_CREATION_REQUESTS_SQL]', {
        action: 'reject',
        requestId,
        coadminUid: ownerCoadminUid,
        sql_ok: sqlRejectOk,
        firestore_fallback: false,
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

    createdAuthUid = null;

    console.info('[USER_DIRECTORY_SQL]', {
      action: 'create_user',
      route: 'approve_carer_request',
      uid: authUser.uid,
      role: 'carer',
      actorUid: admin.uid,
      sql_ok: true,
      firebase_create_ok: firebaseCreateOk,
      firestore_mirror_ok: false,
      firestore_fallback: false,
      durationMs: Date.now() - approveStartedAt,
    });

    console.info('[ADMIN_CARER_CREATION_REQUESTS_SQL]', {
      action: 'approve',
      requestId,
      coadminUid: ownerCoadminUid,
      sql_ok: sqlApproveOk,
      firestore_fallback: false,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      success: true,
      uid: authUser.uid,
      message: 'Carer created after admin approval.',
      sqlOk: true,
      firebaseMirrorOk: firebaseCreateOk,
      firestoreMirrorOk: false,
      requestSqlOk: sqlApproveOk,
      requestFirestoreMirrorOk: false,
      firestore_fallback: false,
      source: 'sql',
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
      firestore_fallback: false,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
