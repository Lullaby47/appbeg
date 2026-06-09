import 'server-only';

export function isAuthSqlReadEnabled() {
  return (
    process.env.AUTH_SQL_READ === '1' ||
    process.env.PLAYER_SESSION_SQL_READ === '1'
  );
}

export function isPlayerSessionSqlReadEnabled() {
  return process.env.PLAYER_SESSION_SQL_READ === '1';
}

export function authSqlReadEnvStatus() {
  return {
    authSqlRead: process.env.AUTH_SQL_READ === '1',
    playerSessionSqlRead: process.env.PLAYER_SESSION_SQL_READ === '1',
    databaseUrlConfigured: Boolean(String(process.env.DATABASE_URL || '').trim()),
  };
}

export function authSqlReadEnvLogFields() {
  const status = authSqlReadEnvStatus();
  return {
    auth_sql_read: status.authSqlRead,
    player_session_sql_read: status.playerSessionSqlRead,
    database_url_configured: status.databaseUrlConfigured,
    sql_read_mode: isAuthSqlReadEnabled(),
  };
}
