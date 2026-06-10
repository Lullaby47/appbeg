'use client';

import {
  readErrorMessage,
  shouldSuppressInternalSqlFirestoreUiError,
} from '@/lib/client/sqlFirestoreError';
import { logCarerFirestoreBlockedSuppressed } from '@/lib/client/carerPageRequestAudit';

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
    return;
  }

  const message = readErrorMessage(error);
  setMessage(message || fallback);
}
