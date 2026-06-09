'use client';

/**
 * NEXT_PUBLIC SQL flags default to enabled in production builds when unset.
 * Set explicit `0` to disable. Local development requires explicit `1`.
 */
export function resolvePublicSqlFlag(name: string) {
  const raw = String(process.env[name] || '').trim();
  if (raw === '1') return true;
  if (raw === '0') return false;
  return process.env.NODE_ENV === 'production';
}

export function isPublicSqlLoginFirstEnabled() {
  return resolvePublicSqlFlag('NEXT_PUBLIC_SQL_LOGIN_FIRST');
}

export function isPublicSqlPlayerLoginEnabled() {
  return resolvePublicSqlFlag('NEXT_PUBLIC_SQL_PLAYER_LOGIN');
}

export function isPublicAutomationJobsSqlReadEnabled() {
  return resolvePublicSqlFlag('NEXT_PUBLIC_AUTOMATION_JOBS_SQL_READ');
}

export function isPublicCarerTasksSqlReadEnabled() {
  return resolvePublicSqlFlag('NEXT_PUBLIC_CARER_TASKS_SQL_READ');
}

export function isPublicPlayerRequestsSqlReadEnabled() {
  return resolvePublicSqlFlag('NEXT_PUBLIC_PLAYER_REQUESTS_SQL_READ');
}

export function isClientSqlReadMode() {
  return (
    isPublicSqlLoginFirstEnabled() ||
    isPublicSqlPlayerLoginEnabled() ||
    isPublicAutomationJobsSqlReadEnabled() ||
    isPublicCarerTasksSqlReadEnabled() ||
    isPublicPlayerRequestsSqlReadEnabled()
  );
}
