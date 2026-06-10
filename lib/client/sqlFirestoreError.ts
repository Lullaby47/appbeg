'use client';

import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

export const INTERNAL_SQL_FIRESTORE_BLOCKED_MESSAGE = 'client_firestore_disabled_sql_mode';

export function readErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || '').trim();
}

export function isInternalSqlModeBlockedFirestoreError(error: unknown) {
  return readErrorMessage(error) === INTERNAL_SQL_FIRESTORE_BLOCKED_MESSAGE;
}

export function logClientFirestoreBlockedSuppressed(values: {
  feature: string;
  route?: string;
  message: string;
}) {
  console.info('[CLIENT_FIRESTORE_BLOCKED_SUPPRESSED]', {
    feature: values.feature,
    route:
      values.route ??
      (typeof window !== 'undefined' ? window.location.pathname || '' : ''),
    message: values.message,
    sqlMode: true,
    userVisible: false,
  });
}

export function shouldSuppressInternalSqlFirestoreUiError(error: unknown) {
  return isClientSqlReadMode() && isInternalSqlModeBlockedFirestoreError(error);
}

export function reportPlayerUiError(
  feature: string,
  error: unknown,
  setMessage: (message: string) => void,
  fallback: string
) {
  if (shouldSuppressInternalSqlFirestoreUiError(error)) {
    logClientFirestoreBlockedSuppressed({
      feature,
      message: readErrorMessage(error),
    });
    return;
  }

  const message = readErrorMessage(error);
  setMessage(message || fallback);
}
