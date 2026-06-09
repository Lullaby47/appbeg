import 'server-only';

export function isAuthoritySqlWriteEnabled() {
  return process.env.AUTHORITY_SQL_WRITE === '1';
}

export function authoritySqlWriteEnvStatus() {
  return {
    authority_sql_write: isAuthoritySqlWriteEnabled(),
    database_url_configured: Boolean(String(process.env.DATABASE_URL || '').trim()),
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

export function logAuthoritySqlWrite(route: string, details: Record<string, unknown> = {}) {
  console.info('[AUTHORITY_SQL_WRITE]', {
    route,
    authority_sql_write: isAuthoritySqlWriteEnabled(),
    firestore_fallback: false,
    ...details,
  });
}

export function logAuthorityFirestoreFallbackBlocked(
  route: string,
  operation: string,
  details: Record<string, unknown> = {}
) {
  console.info('[AUTHORITY_FIRESTORE_FALLBACK_BLOCKED]', {
    route,
    operation,
    authority_sql_write: true,
    ...details,
  });
}
