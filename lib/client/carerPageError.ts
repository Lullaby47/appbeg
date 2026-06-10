'use client';

import {
  isCarerForbiddenMessage,
  friendlyCarerForbiddenMessage,
  logCarerApiForbiddenAudit,
  logCarerInternalErrorSuppressed,
} from '@/lib/client/carerActionAudit';
import { logCarerFirestoreBlockedSuppressed } from '@/lib/client/carerPageRequestAudit';
import {
  readErrorMessage,
  shouldSuppressInternalSqlFirestoreUiError,
} from '@/lib/client/sqlFirestoreError';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

export function shouldSuppressCarerFirestoreBlockedUiError(error: unknown) {
  return shouldSuppressInternalSqlFirestoreUiError(error);
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

  const message = readErrorMessage(error);
  setMessage(message || fallback);
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
  const message = readErrorMessage(error);

  if (shouldSuppressCarerFirestoreBlockedUiError(error)) {
    logCarerFirestoreBlockedSuppressed({
      feature: action,
      file: 'app/carer/page.tsx',
      operation: action,
    });
    logCarerInternalErrorSuppressed({
      action,
      message,
      sqlMode: isClientSqlReadMode(),
      firebaseBlocked: true,
      userVisible: false,
      replacementMessage: null,
    });
    return;
  }

  if (isCarerForbiddenMessage(message) || audit?.status === 403) {
    const friendly = friendlyCarerForbiddenMessage(action);
    logCarerApiForbiddenAudit({
      action,
      route: audit?.route || (typeof window !== 'undefined' ? window.location.pathname : '/carer'),
      method: audit?.method || 'unknown',
      status: audit?.status || 403,
      responseBody: audit?.responseBody ?? { error: message },
      role: 'carer',
      carerUid: audit?.carerUid ?? null,
      coadminUid: audit?.coadminUid ?? null,
      allowedRoles: audit?.allowedRoles ?? null,
      authPath: audit?.authPath ?? null,
      reason: audit?.reason || message || 'forbidden',
      userVisible: true,
    });
    setMessage(friendly);
    return;
  }

  setMessage(message || fallback);
}
