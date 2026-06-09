import 'server-only';

import {
  authoritySqlWriteEnvLogFields,
  authoritySqlWriteEnvStatus,
  isAuthoritySqlWriteEnabled,
  shouldBlockFirestoreFallback,
} from '@/lib/server/sqlRuntime';

export {
  authoritySqlWriteEnvLogFields,
  authoritySqlWriteEnvStatus,
  isAuthoritySqlWriteEnabled,
};

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
    authority_sql_write: shouldBlockFirestoreFallback(),
    ...details,
  });
}
