import 'server-only';

function isProductionNodeEnv() {
  return process.env.NODE_ENV === 'production';
}

function envRaw(name: string) {
  return String(process.env[name] || '').trim();
}

/**
 * Server SQL flags default to enabled in production when unset.
 * Set explicit `0` to disable. Development requires explicit `1`.
 */
export function resolveServerSqlFlag(name: string) {
  const raw = envRaw(name);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return isProductionNodeEnv();
}

export function getDatabaseUrl() {
  return envRaw('DATABASE_URL');
}

export function isDatabaseUrlConfigured() {
  return Boolean(getDatabaseUrl());
}

export function isAuthSqlReadEnabled() {
  return (
    resolveServerSqlFlag('AUTH_SQL_READ') ||
    resolveServerSqlFlag('PLAYER_SESSION_SQL_READ') ||
    resolveServerSqlFlag('APP_SESSION_SQL_READ')
  );
}

export function isPlayerSessionSqlReadEnabled() {
  return resolveServerSqlFlag('PLAYER_SESSION_SQL_READ');
}

export function isAppSessionSqlReadEnabled() {
  return resolveServerSqlFlag('APP_SESSION_SQL_READ');
}

export function isAuthoritySqlWriteEnabled() {
  return resolveServerSqlFlag('AUTHORITY_SQL_WRITE');
}

export function isSqlAuthorityMode() {
  return isAuthSqlReadEnabled() && isAuthoritySqlWriteEnabled();
}

export function shouldBlockFirestoreFallback() {
  return isSqlAuthorityMode() || isAuthSqlReadEnabled() || isAuthoritySqlWriteEnabled();
}

export type SqlRuntimeStatus = {
  node_env: string;
  database_url_configured: boolean;
  auth_sql_read: boolean;
  player_session_sql_read: boolean;
  app_session_sql_read: boolean;
  authority_sql_write: boolean;
  sql_read_mode: boolean;
  sql_authority_mode: boolean;
  firestore_fallback_blocked: boolean;
  authority_source: 'sql' | 'firestore';
};

export function getSqlRuntimeStatus(): SqlRuntimeStatus {
  const authSqlRead = resolveServerSqlFlag('AUTH_SQL_READ');
  const playerSessionSqlRead = resolveServerSqlFlag('PLAYER_SESSION_SQL_READ');
  const appSessionSqlRead = resolveServerSqlFlag('APP_SESSION_SQL_READ');
  const authoritySqlWrite = resolveServerSqlFlag('AUTHORITY_SQL_WRITE');
  const sqlReadMode = isAuthSqlReadEnabled();
  const sqlAuthorityMode = isSqlAuthorityMode();

  return {
    node_env: process.env.NODE_ENV || 'development',
    database_url_configured: isDatabaseUrlConfigured(),
    auth_sql_read: authSqlRead,
    player_session_sql_read: playerSessionSqlRead,
    app_session_sql_read: appSessionSqlRead,
    authority_sql_write: authoritySqlWrite,
    sql_read_mode: sqlReadMode,
    sql_authority_mode: sqlAuthorityMode,
    firestore_fallback_blocked: shouldBlockFirestoreFallback(),
    authority_source: authoritySqlWrite ? 'sql' : 'firestore',
  };
}

export function authSqlReadEnvStatus() {
  return {
    authSqlRead: resolveServerSqlFlag('AUTH_SQL_READ'),
    playerSessionSqlRead: resolveServerSqlFlag('PLAYER_SESSION_SQL_READ'),
    appSessionSqlRead: resolveServerSqlFlag('APP_SESSION_SQL_READ'),
    databaseUrlConfigured: isDatabaseUrlConfigured(),
  };
}

export function authSqlReadEnvLogFields() {
  const status = authSqlReadEnvStatus();
  return {
    auth_sql_read: status.authSqlRead,
    player_session_sql_read: status.playerSessionSqlRead,
    app_session_sql_read: status.appSessionSqlRead,
    database_url_configured: status.databaseUrlConfigured,
    sql_read_mode: isAuthSqlReadEnabled(),
  };
}

export function authoritySqlWriteEnvStatus() {
  return {
    authority_sql_write: isAuthoritySqlWriteEnabled(),
    database_url_configured: isDatabaseUrlConfigured(),
  };
}

export function authoritySqlWriteEnvLogFields() {
  const status = authoritySqlWriteEnvStatus();
  return {
    authority_sql_write: status.authority_sql_write,
    database_url_configured: status.database_url_configured,
    authority_source: status.authority_sql_write ? 'sql' : 'firestore',
  };
}

export class SqlRuntimeMisconfiguredError extends Error {
  readonly code = 'SQL_RUNTIME_MISCONFIGURED';

  constructor(message: string) {
    super(message);
    this.name = 'SqlRuntimeMisconfiguredError';
  }
}

export function logSqlRuntimeMode(context = 'runtime') {
  console.info('[SQL_RUNTIME]', {
    context,
    ...getSqlRuntimeStatus(),
  });
}

export function assertSqlRuntimeReady(context = 'runtime') {
  const status = getSqlRuntimeStatus();
  logSqlRuntimeMode(context);

  if (!isProductionNodeEnv()) {
    return status;
  }

  const problems: string[] = [];
  if (!status.database_url_configured) {
    problems.push('DATABASE_URL is required in production.');
  }
  if (!status.sql_read_mode) {
    problems.push(
      'SQL read mode is required in production (set AUTH_SQL_READ=1, PLAYER_SESSION_SQL_READ=1, and/or APP_SESSION_SQL_READ=1).'
    );
  }
  if (!status.authority_sql_write) {
    problems.push('AUTHORITY_SQL_WRITE=1 is required in production.');
  }

  if (problems.length) {
    throw new SqlRuntimeMisconfiguredError(problems.join(' '));
  }

  return status;
}
