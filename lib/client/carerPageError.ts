'use client';

import {
  isCarerForbiddenMessage,
  logCarerApiForbiddenAudit,
  logCarerInternalErrorSuppressed,
  logCarerNotAuthenticatedAudit,
} from '@/lib/client/carerActionAudit';
import { logCarerFirestoreBlockedSuppressed } from '@/lib/client/carerPageRequestAudit';
import {
  INTERNAL_SQL_FIRESTORE_BLOCKED_MESSAGE,
  readErrorMessage,
  shouldSuppressInternalSqlFirestoreUiError,
} from '@/lib/client/sqlFirestoreError';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

export function shouldSuppressCarerFirestoreBlockedUiError(error: unknown) {
  return shouldSuppressInternalSqlFirestoreUiError(error);
}

function mapCarerActionErrorMessage(action: string, message: string) {
  const normalized = String(message || '').trim().toLowerCase();
  if (
    normalized === INTERNAL_SQL_FIRESTORE_BLOCKED_MESSAGE ||
    normalized.includes('client_firestore_disabled_sql_mode')
  ) {
    return null;
  }
  if (isCarerForbiddenMessage(message)) {
    return 'This action is not available for carers.';
  }
  if (
    normalized.includes('not authenticated') ||
    normalized.includes('not signed in as this carer')
  ) {
    return 'Session changed. Please refresh.';
  }
  if (normalized.includes('outside your scope')) {
    return 'You no longer have access to this task.';
  }
  if (
    action === 'dismiss_recharge' &&
    (normalized.includes('not pending') ||
      normalized.includes('not found') ||
      normalized.includes('already'))
  ) {
    return 'This request was already handled.';
  }
  return message || 'Action unavailable.';
}

export function reportCarerUiError(
  feature: string,
  error: unknown,
  setMessage: (message: string) => void,
  fallback: string,
  context?: { file?: string; operation?: string }
) {
  if (shouldSuppressCarerFirestoreBlockedUiError(error)) {
    logCarerFirestoreBlockedSuppressed({
      feature,
      file: context?.file || 'app/carer/page.tsx',
      operation: context?.operation || feature,
    });
    logCarerInternalErrorSuppressed({
      action: feature,
      message: readErrorMessage(error),
      sqlMode: isClientSqlReadMode(),
      firebaseBlocked: true,
      userVisible: false,
      replacementMessage: null,
    });
    return;
  }

  const mapped = mapCarerActionErrorMessage(feature, readErrorMessage(error));
  setMessage(mapped || fallback);
}

export function reportCarerActionError(
  action: string,
  error: unknown,
  setMessage: (message: string) => void,
  fallback: string,
  audit?: {
    route?: string | null;
    method?: string;
    status?: number;
    responseBody?: unknown;
    carerUid?: string | null;
    coadminUid?: string | null;
    allowedRoles?: string[] | null;
    authPath?: string | null;
    reason?: string;
  }
) {
  const rawMessage = readErrorMessage(error);

  if (shouldSuppressCarerFirestoreBlockedUiError(error)) {
    logCarerFirestoreBlockedSuppressed({
      feature: action,
      file: 'app/carer/page.tsx',
      operation: action,
    });
    logCarerInternalErrorSuppressed({
      action,
      message: rawMessage,
      sqlMode: isClientSqlReadMode(),
      firebaseBlocked: true,
      userVisible: false,
      replacementMessage: null,
    });
    return;
  }

  if (isCarerForbiddenMessage(rawMessage) || audit?.status === 403) {
    const replacement = 'This action is not available for carers.';
    logCarerApiForbiddenAudit({
      action,
      route: audit?.route || (typeof window !== 'undefined' ? window.location.pathname : '/carer'),
      method: audit?.method || 'unknown',
      status: audit?.status || 403,
      responseBody: audit?.responseBody ?? { error: rawMessage },
      role: 'carer',
      carerUid: audit?.carerUid ?? null,
      coadminUid: audit?.coadminUid ?? null,
      allowedRoles: audit?.allowedRoles ?? null,
      authPath: audit?.authPath ?? null,
      reason: audit?.reason || rawMessage || 'forbidden',
      userVisible: true,
    });
    setMessage(replacement);
    return;
  }

  const normalized = rawMessage.toLowerCase();
  if (
    normalized.includes('not authenticated') ||
    normalized.includes('not signed in as this carer')
  ) {
    const replacement = 'Session changed. Please refresh.';
    logCarerNotAuthenticatedAudit({
      action,
      authSource: isClientSqlReadMode() ? 'app_session_sql' : 'firebase_current_user',
      expectedUid: audit?.carerUid ?? null,
      reason: rawMessage,
      file: 'app/carer/page.tsx',
      function: action,
    });
    setMessage(replacement);
    return;
  }

  const mapped = mapCarerActionErrorMessage(action, rawMessage);
  setMessage(mapped || fallback);
}
