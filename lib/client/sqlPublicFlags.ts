'use client';

const PUBLIC_SQL_FLAGS = {
  NEXT_PUBLIC_SQL_LOGIN_FIRST: process.env.NEXT_PUBLIC_SQL_LOGIN_FIRST,
  NEXT_PUBLIC_SQL_PLAYER_LOGIN: process.env.NEXT_PUBLIC_SQL_PLAYER_LOGIN,
  NEXT_PUBLIC_SQL_READ_MODE: process.env.NEXT_PUBLIC_SQL_READ_MODE,
  NEXT_PUBLIC_AUTOMATION_JOBS_SQL_READ: process.env.NEXT_PUBLIC_AUTOMATION_JOBS_SQL_READ,
  NEXT_PUBLIC_CARER_TASKS_SQL_READ: process.env.NEXT_PUBLIC_CARER_TASKS_SQL_READ,
  NEXT_PUBLIC_PLAYER_REQUESTS_SQL_READ: process.env.NEXT_PUBLIC_PLAYER_REQUESTS_SQL_READ,
} as const;

type PublicSqlFlagName = keyof typeof PUBLIC_SQL_FLAGS;

/**
 * NEXT_PUBLIC SQL flags default to enabled in production builds when unset.
 * Set explicit `0` to disable. Local development requires explicit `1`.
 *
 * SQL-only local login should set NEXT_PUBLIC_SQL_LOGIN_FIRST=1 plus the
 * relevant NEXT_PUBLIC_* SQL read flags. Legacy Firebase fallback is separate
 * and stays disabled unless NEXT_PUBLIC_ALLOW_FIREBASE_FALLBACK=1 is explicit.
 *
 * Keep these as static process.env references. Next.js only inlines public
 * env vars into browser bundles when the keys are statically referenced.
 */
export function resolvePublicSqlFlag(name: PublicSqlFlagName) {
  const raw = String(PUBLIC_SQL_FLAGS[name] || '').trim();
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

export function isPublicSqlReadModeEnabled() {
  return resolvePublicSqlFlag('NEXT_PUBLIC_SQL_READ_MODE');
}

export function isPublicLegacyFirebaseFallbackEnabled() {
  return String(process.env.NEXT_PUBLIC_ALLOW_FIREBASE_FALLBACK || '').trim() === '1';
}

export function isPublicFirebaseRuntimeDisabled() {
  return String(process.env.NEXT_PUBLIC_FIREBASE_RUNTIME_DISABLED || '').trim() === '1';
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
    isPublicSqlReadModeEnabled() ||
    isPublicSqlLoginFirstEnabled() ||
    isPublicSqlPlayerLoginEnabled() ||
    isPublicAutomationJobsSqlReadEnabled() ||
    isPublicCarerTasksSqlReadEnabled() ||
    isPublicPlayerRequestsSqlReadEnabled()
  );
}
