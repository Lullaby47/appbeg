import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { AUTOMATION_AUTO_STATE_COLLECTION } from '@/features/automation/automationAutoState';
import { apiError, requireCarerApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { adminDb } from '@/lib/firebase/admin';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import {
  lookupAutomationAutoStateFromSqlCache,
  upsertAutomationAutoStateCache,
} from '@/lib/sql/automationAutoStateCache';

const ROUTE = '/api/carer/automation-auto-state';

function mapSqlStateToClient(state: {
  enabled: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}) {
  return {
    enabled: state.enabled,
    tickLeaseHolderId: state.leaseOwner,
    tickLeaseExpiresAt: state.leaseExpiresAt,
  };
}

function mapFirestoreStateToClient(data: Record<string, unknown>) {
  return {
    enabled: data.enabled === true,
    tickLeaseHolderId:
      typeof data.tickLeaseHolderId === 'string' ? data.tickLeaseHolderId : null,
    tickLeaseExpiresAt: data.tickLeaseExpiresAt ?? null,
    startedAt: data.startedAt ?? null,
    startedBy: typeof data.startedBy === 'string' ? data.startedBy : null,
    stoppedAt: data.stoppedAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireCarerApiUser(request);
  if ('response' in auth) {
    return auth.response;
  }

  const coadminUid = scopedCoadminUid(auth.user);

  if (isAuthSqlReadEnabled()) {
    const lookup = await lookupAutomationAutoStateFromSqlCache(auth.user.uid);
    const durationMs = Date.now() - startedAt;

    console.info('[AUTOMATION_AUTO_STATE_SQL_READ]', {
      carerUid: auth.user.uid,
      coadminUid,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
    });

    if (!lookup.state) {
      return NextResponse.json({
        state: null,
        source: 'sql',
        firestore_fallback: false,
        durationMs,
      });
    }

    return NextResponse.json({
      state: mapSqlStateToClient(lookup.state),
      source: 'sql',
      firestore_fallback: false,
      durationMs,
    });
  }

  const snap = await adminDb
    .collection(AUTOMATION_AUTO_STATE_COLLECTION)
    .doc(auth.user.uid)
    .get();

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: ROUTE,
    operation: 'read',
    collection: AUTOMATION_AUTO_STATE_COLLECTION,
    document_id: auth.user.uid,
    sql_read_mode: false,
    skipped: false,
    details: { uid: auth.user.uid },
  });

  const durationMs = Date.now() - startedAt;

  if (!snap.exists) {
    return NextResponse.json({
      state: null,
      source: 'firestore',
      firestore_fallback: true,
      durationMs,
    });
  }

  return NextResponse.json({
    state: mapFirestoreStateToClient((snap.data() || {}) as Record<string, unknown>),
    source: 'firestore',
    firestore_fallback: true,
    durationMs,
  });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const auth = await requireCarerApiUser(request);
  if ('response' in auth) {
    return auth.response;
  }

  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  const enabled = body.enabled === true;
  const coadminUid = scopedCoadminUid(auth.user);
  if (!coadminUid) {
    return apiError('Coadmin scope is required.', 400);
  }

  if (isAuthSqlReadEnabled()) {
    const now = new Date().toISOString();
    const ok = await upsertAutomationAutoStateCache(
      auth.user.uid,
      {
        enabled,
        updatedAt: now,
        ...(enabled
          ? {
              startedAt: now,
              startedBy: auth.user.uid,
              stoppedAt: null,
            }
          : {
              stoppedAt: now,
            }),
      },
      'carer_sql_write',
      coadminUid
    );

    const durationMs = Date.now() - startedAt;

    if (!ok) {
      return apiError('Failed to save automation auto state.', 500);
    }

    console.info('[AUTOMATION_AUTO_STATE_SQL_WRITE]', {
      carerUid: auth.user.uid,
      coadminUid,
      enabled,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
    });

    return NextResponse.json({
      ok: true,
      enabled,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
    });
  }

  const ref = adminDb.collection(AUTOMATION_AUTO_STATE_COLLECTION).doc(auth.user.uid);
  await ref.set(
    {
      enabled,
      updatedAt: FieldValue.serverTimestamp(),
      ...(enabled
        ? {
            startedAt: FieldValue.serverTimestamp(),
            startedBy: auth.user.uid,
            stoppedAt: null,
          }
        : {
            stoppedAt: FieldValue.serverTimestamp(),
          }),
    },
    { merge: true }
  );

  logFirestoreTouch({
    firestore_touch_type: 'authority_write_keep_for_now',
    route: ROUTE,
    operation: 'write',
    collection: AUTOMATION_AUTO_STATE_COLLECTION,
    document_id: auth.user.uid,
    sql_read_mode: false,
    skipped: false,
    details: { uid: auth.user.uid, enabled },
  });

  const durationMs = Date.now() - startedAt;

  return NextResponse.json({
    ok: true,
    enabled,
    source: 'firestore',
    firestoreAttempted: true,
    durationMs,
  });
}
