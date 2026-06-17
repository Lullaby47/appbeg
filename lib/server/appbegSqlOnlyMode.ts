import 'server-only';

import { isProductionNodeEnv, resolveServerSqlFlag } from '@/lib/server/sqlRuntime';
import { isSqlAuthVerboseLogs } from '@/lib/server/verboseLogs';

function envRaw(name: string) {
  return String(process.env[name] || '').trim();
}

/**
 * When enabled, runtime Firestore reads/writes are blocked outside migration-only paths.
 * Defaults to enabled in production when unset; set explicit `0` to disable.
 */
export function isAppbegSqlOnlyMode() {
  return resolveServerSqlFlag('APPBEG_SQL_ONLY_MODE');
}

/** Financial / legacy Firestore else-branches. Default off unless explicitly `1`. */
export function isFirebaseFallbackAllowed() {
  return envRaw('ALLOW_FIREBASE_FALLBACK') === '1';
}

export function isAuthFirestoreFallbackAllowed() {
  return !isAppbegSqlOnlyMode() && isFirebaseFallbackAllowed();
}

export function shouldAuthUseSqlOnly() {
  return isAppbegSqlOnlyMode() || resolveServerSqlFlag('AUTH_SQL_READ');
}

let startupLogged = false;

export function logAppbegSqlOnlyModeStartup(context = 'startup') {
  if (startupLogged && context === 'startup') {
    return;
  }
  if (context === 'startup') {
    startupLogged = true;
  }

  const sqlOnly = isAppbegSqlOnlyMode();
  const firebaseFallback = isFirebaseFallbackAllowed();

  console.info('[APPBEG_SQL_ONLY_MODE] enabled=%s', String(sqlOnly).toLowerCase());
  console.info('[FIREBASE_RUNTIME_DISABLED] enabled=%s', String(sqlOnly).toLowerCase());

  if (sqlOnly) {
    console.info('[FIREBASE_RUNTIME_GUARD] migration_paths_allowed=scripts/firebase-backfill,lib/firebase/migrationOnly,app/api/admin/migration');
  }

  console.info('[APPBEG_SQL_ONLY_FLAGS]', {
    context,
    appbeg_sql_only_mode: sqlOnly,
    allow_firebase_fallback: firebaseFallback,
    auth_sql_only: shouldAuthUseSqlOnly(),
    node_env: process.env.NODE_ENV || 'development',
    production_default: isProductionNodeEnv(),
  });
}

export function logSqlAuthProfileRead(input: {
  uid: string;
  role?: string | null;
  source: 'sql';
  missReason?: string | null;
  route?: string;
}) {
  if (!isSqlAuthVerboseLogs()) {
    return;
  }
  console.info('[SQL_AUTH_PROFILE_READ]', {
    uid: input.uid,
    role: input.role ?? null,
    source: input.source,
    miss_reason: input.missReason ?? null,
    route: input.route ?? null,
  });
}

export function logSqlAuthSessionRead(input: {
  uid: string;
  sessionId?: string | null;
  source: 'sql';
  missReason?: string | null;
  route?: string;
}) {
  if (!isSqlAuthVerboseLogs()) {
    return;
  }
  console.info('[SQL_AUTH_SESSION_READ]', {
    uid: input.uid,
    session_id: input.sessionId ?? null,
    source: input.source,
    miss_reason: input.missReason ?? null,
    route: input.route ?? null,
  });
}

export function logSqlAuthNoFirestore(route: string, details?: Record<string, unknown>) {
  if (!isSqlAuthVerboseLogs()) {
    return;
  }
  console.info('[SQL_AUTH_NO_FIRESTORE]', {
    route,
    ...(details || {}),
  });
}

export function logFirebaseAuthFallbackDisabled(
  route: string,
  reason: string,
  details?: Record<string, unknown>
) {
  console.info('[FIREBASE_AUTH_FALLBACK_DISABLED]', {
    route,
    reason,
    appbeg_sql_only_mode: isAppbegSqlOnlyMode(),
    allow_firebase_fallback: isFirebaseFallbackAllowed(),
    ...(details || {}),
  });
}
