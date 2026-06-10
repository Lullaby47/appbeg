import { NextResponse } from 'next/server';

import { apiError, requireCarerApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
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

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireCarerApiUser(request);
  if ('response' in auth) {
    return auth.response;
  }

  const sqlReadMode = isAuthSqlReadEnabled();
  const lookup = await lookupAutomationAutoStateFromSqlCache(auth.user.uid);

  if (sqlReadMode) {
    logFirestoreTouch({
      firestore_touch_type: 'legacy_read_remove_now',
      route: ROUTE,
      operation: 'read',
      collection: 'automation_auto_state',
      skipped: true,
      sql_read_mode: true,
      details: { uid: auth.user.uid, reason: 'sql_read_mode' },
    });
  }

  if (!lookup.state) {
    if (sqlReadMode) {
      return NextResponse.json({
        state: null,
        source: 'sql',
        firestore_fallback: false,
        durationMs: Date.now() - startedAt,
      });
    }
    return NextResponse.json({
      state: null,
      source: 'sql_miss',
      firestore_fallback: false,
      durationMs: Date.now() - startedAt,
    });
  }

  return NextResponse.json({
    state: mapSqlStateToClient(lookup.state),
    source: 'sql',
    firestore_fallback: false,
    durationMs: Date.now() - startedAt,
  });
}

export async function POST(request: Request) {
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

  if (!ok) {
    return apiError('Failed to save automation auto state.', 500);
  }

  console.info('[CARER_AUTOMATION_STATE_SQL_WRITE]', {
    carerUid: auth.user.uid,
    enabled,
    source: 'sql',
    firestoreAttempted: false,
  });

  return NextResponse.json({
    ok: true,
    enabled,
    source: 'sql',
    firestoreAttempted: false,
  });
}
