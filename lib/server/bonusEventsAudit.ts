import 'server-only';

import {
  authSqlReadEnvLogFields,
  isAppSessionSqlReadEnabled,
  isAuthoritySqlWriteEnabled,
  isAuthSqlReadEnabled,
} from '@/lib/server/sqlRuntime';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

export function bonusEventsRequestHeaderFlags(request: Request) {
  return {
    has_app_session_header: Boolean(cleanText(request.headers.get('X-App-Session-Id'))),
    has_player_session_header: Boolean(cleanText(request.headers.get('X-Player-Session-Id'))),
  };
}

export function bonusEventsSqlModeFlags() {
  return {
    ...authSqlReadEnvLogFields(),
    authority_sql_write: isAuthoritySqlWriteEnabled(),
    app_session_sql_read: isAppSessionSqlReadEnabled(),
  };
}

export function logBonusEventsBlocked(values: {
  route: string;
  role?: string | null;
  uid?: string | null;
  reason: string;
  requiredAuth?: string;
  receivedAuth?: string | null;
  hasAppSessionId?: boolean;
  hasPlayerSessionId?: boolean;
  details?: Record<string, unknown>;
}) {
  console.info('[BONUS_EVENTS_BLOCKED]', {
    route: values.route,
    role: values.role ?? null,
    uid: values.uid ?? null,
    reason: values.reason,
    requiredAuth: values.requiredAuth ?? null,
    receivedAuth: values.receivedAuth ?? null,
    hasAppSessionId: values.hasAppSessionId ?? null,
    hasPlayerSessionId: values.hasPlayerSessionId ?? null,
    ...values.details,
  });
}

export function logBonusEventsListAuth(
  request: Request,
  values: {
    route: string;
    uid: string;
    role: string;
    coadminUid: string;
    auth_path: string;
    source: string;
  }
) {
  console.info('[BONUS_EVENTS_LIST_AUTH]', {
    route: values.route,
    uid: values.uid,
    role: values.role,
    coadminUid: values.coadminUid,
    auth_path: values.auth_path,
    source: values.source,
    ...bonusEventsSqlModeFlags(),
    ...bonusEventsRequestHeaderFlags(request),
  });
}

export function logBonusEventsListSql(values: {
  route: string;
  coadminUid: string;
  count: number;
  activeCount: number;
  sql_ms: number;
  firestore_fallback: boolean;
  reason: string;
}) {
  console.info('[BONUS_EVENTS_LIST_SQL]', {
    route: values.route,
    table: 'bonus_events_cache',
    coadminUid: values.coadminUid,
    count: values.count,
    activeCount: values.activeCount,
    sql_ms: values.sql_ms,
    firestore_fallback: values.firestore_fallback,
    reason: values.reason,
  });
}

export function logBonusEventsEnsureAuth(
  request: Request,
  values: {
    route: string;
    uid: string;
    role: string;
    coadminUid: string;
    auth_path: string;
    source: string;
  }
) {
  console.info('[BONUS_EVENTS_ENSURE_AUTH]', {
    route: values.route,
    uid: values.uid,
    role: values.role,
    coadminUid: values.coadminUid,
    auth_path: values.auth_path,
    source: values.source,
    ...bonusEventsRequestHeaderFlags(request),
  });
}

export function logBonusEventsEnsureSql(values: {
  route: string;
  coadminUid: string;
  beforeCount: number;
  createdCount: number;
  afterCount: number;
  minPercent: number | null;
  maxPercent: number | null;
  authority_sql_write: boolean;
  firestore_fallback: boolean;
  reason: string;
}) {
  console.info('[BONUS_EVENTS_ENSURE_SQL]', {
    route: values.route,
    table: 'bonus_events_cache',
    coadminUid: values.coadminUid,
    beforeCount: values.beforeCount,
    createdCount: values.createdCount,
    afterCount: values.afterCount,
    minPercent: values.minPercent,
    maxPercent: values.maxPercent,
    authority_sql_write: values.authority_sql_write,
    firestore_fallback: values.firestore_fallback,
    reason: values.reason,
  });
}

export function logBonusEventsRangeSql(values: {
  route: string;
  coadminUid: string;
  oldMin: number | null;
  oldMax: number | null;
  newMin: number;
  newMax: number;
  affectedEvents: number;
  authority_sql_write: boolean;
  firestore_fallback: boolean;
  reason: string;
}) {
  console.info('[BONUS_EVENTS_RANGE_SQL]', {
    route: values.route,
    table: 'coadmin_bonus_settings_cache',
    coadminUid: values.coadminUid,
    oldMin: values.oldMin,
    oldMax: values.oldMax,
    newMin: values.newMin,
    newMax: values.newMax,
    affectedEvents: values.affectedEvents,
    authority_sql_write: values.authority_sql_write,
    firestore_fallback: values.firestore_fallback,
    reason: values.reason,
  });
}

export function logBonusEventsInitiateAuth(
  request: Request,
  values: {
    route: string;
    playerUid: string;
    coadminUid: string | null;
    auth_path: string;
    session_source: string;
    reason: string;
  }
) {
  console.info('[BONUS_EVENTS_INITIATE_AUTH]', {
    route: values.route,
    playerUid: values.playerUid,
    coadminUid: values.coadminUid,
    auth_path: values.auth_path,
    session_source: values.session_source,
    ...bonusEventsRequestHeaderFlags(request),
    reason: values.reason,
  });
}
