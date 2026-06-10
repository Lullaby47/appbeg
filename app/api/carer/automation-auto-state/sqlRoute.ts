import 'server-only';

import { NextResponse } from 'next/server';

import { lookupAutomationAutoStateFromSqlCache, upsertAutomationAutoStateCache } from '@/lib/sql/automationAutoStateCache';

import { logAutomationAutoStateRouteVersion } from './routeVersion';

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

export async function getAutomationAutoStateSql(input: {
  carerUid: string;
  coadminUid: string | null;
  startedAt: number;
}) {
  logAutomationAutoStateRouteVersion({
    method: 'GET',
    sqlMode: true,
    carerUid: input.carerUid,
    branch: 'sql_read_start',
  });

  try {
    const lookup = await lookupAutomationAutoStateFromSqlCache(input.carerUid);
    const durationMs = Date.now() - input.startedAt;

    console.info('[AUTOMATION_AUTO_STATE_SQL_READ]', {
      carerUid: input.carerUid,
      coadminUid: input.coadminUid,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
      missReason: lookup.missReason,
      hasState: Boolean(lookup.state),
    });

    if (!lookup.state) {
      return NextResponse.json({
        state: null,
        source: 'sql',
        firestore_fallback: false,
        durationMs,
        missReason: lookup.missReason,
      });
    }

    return NextResponse.json({
      state: mapSqlStateToClient(lookup.state),
      source: 'sql',
      firestore_fallback: false,
      durationMs,
    });
  } catch (error) {
    const durationMs = Date.now() - input.startedAt;
    console.error('[AUTOMATION_AUTO_STATE_SQL_READ]', {
      carerUid: input.carerUid,
      coadminUid: input.coadminUid,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        state: null,
        source: 'sql',
        firestore_fallback: false,
        durationMs,
        error: 'lookup_failed',
      },
      { status: 503 }
    );
  }
}

export async function postAutomationAutoStateSql(input: {
  carerUid: string;
  coadminUid: string;
  enabled: boolean;
  startedAt: number;
}) {
  logAutomationAutoStateRouteVersion({
    method: 'POST',
    sqlMode: true,
    carerUid: input.carerUid,
    branch: 'sql_write_start',
  });

  try {
    const now = new Date().toISOString();
    const ok = await upsertAutomationAutoStateCache(
      input.carerUid,
      {
        enabled: input.enabled,
        updatedAt: now,
        ...(input.enabled
          ? {
              startedAt: now,
              startedBy: input.carerUid,
              stoppedAt: null,
            }
          : {
              stoppedAt: now,
            }),
      },
      'carer_sql_write',
      input.coadminUid
    );

    const durationMs = Date.now() - input.startedAt;

    if (!ok) {
      console.error('[AUTOMATION_AUTO_STATE_SQL_WRITE]', {
        carerUid: input.carerUid,
        coadminUid: input.coadminUid,
        enabled: input.enabled,
        source: 'sql',
        firestoreAttempted: false,
        durationMs,
        ok: false,
      });
      return NextResponse.json(
        { error: 'Failed to save automation auto state.', source: 'sql' },
        { status: 500 }
      );
    }

    console.info('[AUTOMATION_AUTO_STATE_SQL_WRITE]', {
      carerUid: input.carerUid,
      coadminUid: input.coadminUid,
      enabled: input.enabled,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
      ok: true,
    });

    return NextResponse.json({
      ok: true,
      enabled: input.enabled,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
    });
  } catch (error) {
    const durationMs = Date.now() - input.startedAt;
    console.error('[AUTOMATION_AUTO_STATE_SQL_WRITE]', {
      carerUid: input.carerUid,
      coadminUid: input.coadminUid,
      enabled: input.enabled,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to save automation auto state.', source: 'sql' },
      { status: 500 }
    );
  }
}
