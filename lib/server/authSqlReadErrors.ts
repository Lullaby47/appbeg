import 'server-only';

import { apiError } from '@/lib/firebase/apiAuth';
import type { ApiUserSqlProfileLookupResult } from '@/lib/sql/playersCache';

export function authSqlProfileErrorResponse(
  lookup: Pick<ApiUserSqlProfileLookupResult, 'missReason'>,
  options?: { route?: string }
) {
  const reason = lookup.missReason || 'profile_missing';
  const route = options?.route || 'auth';

  if (reason === 'postgres_unavailable') {
    console.info('[AUTH_SQL_READ] profile lookup failed route=%s reason=%s', route, reason);
    return apiError(
      'SQL auth is unavailable. Configure DATABASE_URL on the server.',
      503
    );
  }

  if (reason === 'lookup_failed') {
    console.info('[AUTH_SQL_READ] profile lookup failed route=%s reason=%s', route, reason);
    return apiError('SQL user profile lookup failed.', 503);
  }

  if (reason === 'row_missing') {
    console.info('[AUTH_SQL_READ] profile lookup failed route=%s reason=%s', route, reason);
    return apiError(
      'User profile not found in SQL cache. Ensure players_cache is populated for this user.',
      404
    );
  }

  console.info('[AUTH_SQL_READ] profile lookup failed route=%s reason=%s', route, reason);
  return apiError('User profile not found.', 401);
}

export function authSqlEnvErrorResponse(options?: { route?: string }) {
  const route = options?.route || 'auth';
  console.info('[AUTH_SQL_READ] env misconfigured route=%s reason=missing_database_url', route);
  return apiError('DATABASE_URL is not configured for SQL auth.', 503);
}

export function logAuthSqlRouteStart(route: string, extra?: Record<string, unknown>) {
  console.info('[AUTH_SQL_READ]', {
    route,
    ...extra,
  });
}
