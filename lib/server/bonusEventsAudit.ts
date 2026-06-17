import 'server-only';

import { NextResponse } from 'next/server';

import {
  authSqlReadEnvLogFields,
  isAppSessionSqlReadEnabled,
  isAuthoritySqlWriteEnabled,
  isAuthSqlReadEnabled,
} from '@/lib/server/sqlRuntime';
import { isBonusVerboseLogs } from '@/lib/server/verboseLogs';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

export function bonusEventsRequestHeaderFlags(request: Request) {
  return {
    has_app_session_header: Boolean(cleanText(request.headers.get('X-App-Session-Id'))),
    has_player_session_header: Boolean(cleanText(request.headers.get('X-Player-Session-Id'))),
  };
}

function sessionHeaderPrefix(request: Request, headerName: string) {
  const value = cleanText(request.headers.get(headerName));
  return value ? value.slice(0, 8) : null;
}

export function logPlayerBonusSessionHeaderCheck(
  request: Request,
  values: {
    route: string;
    method: string;
    auth_path?: string | null;
    reason: string;
  }
) {
  const headerFlags = bonusEventsRequestHeaderFlags(request);
  console.info('[PLAYER_BONUS_SESSION_HEADER_CHECK]', {
    route: values.route,
    method: values.method,
    hasAppSessionHeader: headerFlags.has_app_session_header,
    hasPlayerSessionHeader: headerFlags.has_player_session_header,
    appSessionIdPrefix: sessionHeaderPrefix(request, 'X-App-Session-Id'),
    playerSessionIdPrefix: sessionHeaderPrefix(request, 'X-Player-Session-Id'),
    auth_path: values.auth_path ?? null,
    reason: values.reason,
  });
}

export function logPlayerBonusListSql(values: {
  route: string;
  playerUid: string;
  playerCoadminUid: string;
  queriedCoadminUid: string;
  totalRowsForCoadmin: number;
  returnedCount: number;
  reason: string;
}) {
  console.info('[PLAYER_BONUS_LIST_SQL]', {
    route: values.route,
    playerUid: values.playerUid,
    playerCoadminUid: values.playerCoadminUid,
    queriedCoadminUid: values.queriedCoadminUid,
    totalRowsForCoadmin: values.totalRowsForCoadmin,
    returnedCount: values.returnedCount,
    reason: values.reason,
  });
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
  coadminUid?: string | null;
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
    coadminUid: values.coadminUid ?? null,
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

export type BonusEventsListSqlFilterSampleRow = {
  firebase_id: string;
  coadmin_uid: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  amount_npr: number | null;
  bonus_percentage: number | null;
};

export function logBonusEventsListSqlFilter(values: {
  route: string;
  coadminUid: string;
  totalRowsForCoadmin: number;
  activeRowsForCoadmin: number;
  returnedCount: number;
  statusesSeen: string[];
  now: string;
  sampleRows: BonusEventsListSqlFilterSampleRow[];
  reason: string;
}) {
  if (!isBonusVerboseLogs()) {
    return;
  }
  console.info('[BONUS_EVENTS_LIST_SQL_FILTER]', {
    route: values.route,
    coadminUid: values.coadminUid,
    totalRowsForCoadmin: values.totalRowsForCoadmin,
    activeRowsForCoadmin: values.activeRowsForCoadmin,
    returnedCount: values.returnedCount,
    statusesSeen: values.statusesSeen,
    now: values.now,
    sampleRows: values.sampleRows,
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
    ...bonusEventsSqlModeFlags(),
    ...bonusEventsRequestHeaderFlags(request),
  });
}

export function resolveCoadminBonusAuthFailure(
  request: Request,
  route: string,
  auth: { response: NextResponse; timing?: { auth_path?: string | null } },
  coadminUid?: string | null
) {
  const headerFlags = bonusEventsRequestHeaderFlags(request);
  const hasAppSession = headerFlags.has_app_session_header;
  const reason = hasAppSession ? 'auth_failed' : 'app_session_required';
  logBonusEventsBlocked({
    route,
    coadminUid: coadminUid ?? null,
    reason,
    requiredAuth: 'app_session_sql',
    receivedAuth: auth.timing?.auth_path || null,
    hasAppSessionId: hasAppSession,
    hasPlayerSessionId: headerFlags.has_player_session_header,
  });
  if (!hasAppSession) {
    return NextResponse.json(
      { error: 'App session required.', reason: 'app_session_required' },
      { status: 401 }
    );
  }
  return auth.response;
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

export function logPlayerBonusAuth(
  request: Request,
  values: {
    route: string;
    playerUid: string;
    auth_path: string;
    session_source?: string | null;
    reason: string;
  }
) {
  console.info('[PLAYER_BONUS_AUTH]', {
    route: values.route,
    playerUid: values.playerUid,
    auth_path: values.auth_path,
    has_app_session_header: bonusEventsRequestHeaderFlags(request).has_app_session_header,
    has_player_session_header: bonusEventsRequestHeaderFlags(request).has_player_session_header,
    session_source: values.session_source ?? 'none',
    reason: values.reason,
  });
}
