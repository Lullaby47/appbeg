import 'server-only';

import { NextResponse } from 'next/server';

import { shouldBlockFirestoreFallback } from '@/lib/server/sqlRuntime';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import { API_ROUTE_SLOW_MS, isSqlCacheVerboseLogs } from '@/lib/server/verboseLogs';
import { recordRouteMetric } from '@/lib/server/logMetrics';

export function isCacheSqlAuthoritative() {
  return shouldBlockFirestoreFallback();
}

export function logCacheSqlRead(route: string, details: Record<string, unknown> = {}) {
  const durationMs = Number(details.durationMs);
  if (Number.isFinite(durationMs)) {
    recordRouteMetric({
      route,
      durationMs,
      ok: true,
      slowThresholdMs: API_ROUTE_SLOW_MS,
    });
  }
  if (!isSqlCacheVerboseLogs()) {
    return;
  }
  console.info('[CACHE_SQL_READ]', {
    route,
    source: 'sql',
    firestore_fallback: false,
    ...details,
  });
}

export function logCacheFirestoreFallbackBlocked(
  route: string,
  collection: string,
  details: Record<string, unknown> = {}
) {
  logFirestoreTouch({
    firestore_touch_type: 'legacy_read_remove_now',
    route,
    operation: 'read',
    collection,
    skipped: true,
    sql_read_mode: true,
    details: { reason: 'sql_cache_authoritative', ...details },
  });
  if (!isSqlCacheVerboseLogs()) {
    return;
  }
  console.info('[CACHE_SQL_READ]', {
    route,
    source: 'sql',
    firestore_fallback: false,
    cache_miss: true,
    ...details,
  });
}

export function mirrorSqlSkipResponse(
  route: string,
  collection: string,
  details: Record<string, unknown> = {}
) {
  logFirestoreTouch({
    firestore_touch_type: 'mirror_write_can_disable',
    route,
    operation: 'read',
    collection,
    skipped: true,
    sql_read_mode: true,
    details: { reason: 'sql_cache_authoritative', ...details },
  });
  return NextResponse.json({
    ok: true,
    skipped: true,
    reason: 'sql_cache_authoritative',
    ...details,
  });
}
