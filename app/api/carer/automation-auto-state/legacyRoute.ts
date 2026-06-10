import 'server-only';

import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { AUTOMATION_AUTO_STATE_COLLECTION } from '@/features/automation/automationAutoState';
import { adminDb } from '@/lib/firebase/admin';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';

import { logAutomationAutoStateRouteVersion } from './routeVersion';

const ROUTE = '/api/carer/automation-auto-state';

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

export async function getAutomationAutoStateLegacy(input: {
  carerUid: string;
  startedAt: number;
}) {
  logAutomationAutoStateRouteVersion({
    method: 'GET',
    sqlMode: false,
    carerUid: input.carerUid,
    branch: 'legacy_read_start',
  });

  const snap = await adminDb
    .collection(AUTOMATION_AUTO_STATE_COLLECTION)
    .doc(input.carerUid)
    .get();

  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route: ROUTE,
    operation: 'read',
    collection: AUTOMATION_AUTO_STATE_COLLECTION,
    document_id: input.carerUid,
    sql_read_mode: false,
    skipped: false,
    details: { uid: input.carerUid },
  });

  const durationMs = Date.now() - input.startedAt;

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

export async function postAutomationAutoStateLegacy(input: {
  carerUid: string;
  enabled: boolean;
  startedAt: number;
}) {
  logAutomationAutoStateRouteVersion({
    method: 'POST',
    sqlMode: false,
    carerUid: input.carerUid,
    branch: 'legacy_write_start',
  });

  const ref = adminDb.collection(AUTOMATION_AUTO_STATE_COLLECTION).doc(input.carerUid);
  await ref.set(
    {
      enabled: input.enabled,
      updatedAt: FieldValue.serverTimestamp(),
      ...(input.enabled
        ? {
            startedAt: FieldValue.serverTimestamp(),
            startedBy: input.carerUid,
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
    document_id: input.carerUid,
    sql_read_mode: false,
    skipped: false,
    details: { uid: input.carerUid, enabled: input.enabled },
  });

  const durationMs = Date.now() - input.startedAt;

  return NextResponse.json({
    ok: true,
    enabled: input.enabled,
    source: 'firestore',
    firestoreAttempted: true,
    durationMs,
  });
}
