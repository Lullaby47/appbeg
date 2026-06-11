import { randomUUID } from 'crypto';

import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { requireApiUser } from '@/lib/firebase/apiAuth';
import { isCacheSqlAuthoritative } from '@/lib/server/cacheSqlRead';
import {
  isAuthoritySqlWriteEnabled,
  logAuthorityFirestoreFallbackBlocked,
} from '@/lib/server/authoritySqlWrite';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import {
  createCarerCreationRequestSql,
  hasPendingCarerCreationRequestSql,
} from '@/lib/sql/carerCreationRequestsCache';
import { isActiveUsernameTakenInSql } from '@/lib/sql/userDirectoryWrite';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const startedAt = Date.now();
  let requestId = '';

  try {
    const auth = await requireApiUser(request, ['coadmin']);
    if ('response' in auth) {
      return auth.response;
    }
    const callerUid = auth.user.uid;
    console.info('[COADMIN_REQUEST_CARER_AUTH]', {
      auth_path: auth.authPath,
      uid: callerUid,
      app_session_used: auth.authPath.startsWith('app_session'),
    });

    const body = (await request.json()) as { username?: string };
    const requestedUsername = String(body.username || '').trim().toLowerCase();
    if (!requestedUsername) {
      return NextResponse.json({ error: 'Username is required.' }, { status: 400 });
    }

    if (await isActiveUsernameTakenInSql(requestedUsername)) {
      return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
    }

    const sqlReadMode = isCacheSqlAuthoritative();

    if (!sqlReadMode) {
      logFirestoreTouch({
        firestore_touch_type: 'legacy_read_remove_now',
        route: '/api/coadmin/request-carer',
        operation: 'read',
        collection: 'users',
        sql_read_mode: false,
        details: { context: 'username_dup_check' },
      });
      const existsSnap = await adminDb
        .collection('users')
        .where('username', '==', requestedUsername)
        .limit(1)
        .get();
      if (!existsSnap.empty) {
        return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
      }
    }

    if (await hasPendingCarerCreationRequestSql(callerUid, requestedUsername)) {
      return NextResponse.json(
        { error: 'This carer request is already pending approval.' },
        { status: 409 }
      );
    }

    if (!sqlReadMode) {
      logFirestoreTouch({
        firestore_touch_type: 'legacy_read_remove_now',
        route: '/api/coadmin/request-carer',
        operation: 'read',
        collection: 'carerCreationRequests',
        sql_read_mode: false,
        details: { context: 'pending_dup_check' },
      });
      const pendingSnap = await adminDb
        .collection('carerCreationRequests')
        .where('coadminUid', '==', callerUid)
        .where('requestedUsername', '==', requestedUsername)
        .where('status', '==', 'pending')
        .limit(1)
        .get();
      if (!pendingSnap.empty) {
        return NextResponse.json(
          { error: 'This carer request is already pending approval.' },
          { status: 409 }
        );
      }
    }

    requestId = randomUUID();
    let sqlOk = false;
    try {
      await createCarerCreationRequestSql({
        requestId,
        coadminUid: callerUid,
        coadminUsername: auth.user.username || 'Coadmin',
        username: requestedUsername,
      });
      sqlOk = true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create carer request in SQL.';
      const isDuplicate =
        message.includes('carer_creation_requests_cache_pending_coadmin_username_idx') ||
        message.includes('duplicate key');
      console.info('[CARER_CREATION_REQUEST_SQL]', {
        action: 'create',
        requestId,
        coadminUid: callerUid,
        sql_ok: false,
        firestore_mirror_ok: false,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return NextResponse.json(
        {
          error: isDuplicate
            ? 'This carer request is already pending approval.'
            : message,
        },
        { status: isDuplicate ? 409 : 500 }
      );
    }

    let firestoreMirrorOk = false;
    if (isAuthoritySqlWriteEnabled()) {
      logAuthorityFirestoreFallbackBlocked('/api/coadmin/request-carer', 'carerCreationRequests.set', {
        requestId,
        coadminUid: callerUid,
      });
    } else {
      try {
        await adminDb.collection('carerCreationRequests').doc(requestId).set({
          coadminUid: callerUid,
          coadminUsername: auth.user.username || 'Coadmin',
          requestedUsername,
          status: 'pending',
          requestedAt: new Date(),
          reviewedAt: null,
          reviewedByUid: null,
          reviewedByUsername: null,
          createdCarerUid: null,
          note: null,
        });
        firestoreMirrorOk = true;
      } catch (error) {
        console.warn('[CARER_CREATION_REQUEST_SQL] firestore mirror failed', {
          action: 'create',
          requestId,
          coadminUid: callerUid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.info('[CARER_CREATION_REQUEST_SQL]', {
      action: 'create',
      requestId,
      coadminUid: callerUid,
      sql_ok: sqlOk,
      firestore_mirror_ok: firestoreMirrorOk,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      success: true,
      requestId,
      sqlOk,
      firestoreMirrorOk,
      message: 'Carer request submitted for admin approval.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to request carer creation.';
    console.info('[CARER_CREATION_REQUEST_SQL]', {
      action: 'create',
      requestId: requestId || '',
      coadminUid: '',
      sql_ok: false,
      firestore_mirror_ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
