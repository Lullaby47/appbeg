'use client';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

export function logCarerAction(input: {
  action: string;
  file: string;
  function: string;
  route?: string | null;
  method?: string | null;
  carerUid?: string | null;
  coadminUid?: string | null;
  role?: string | null;
  authHeaderMode?: string | null;
}) {
  console.info('[CARER_ACTION_AUDIT]', {
    ...input,
    hasAppSessionId: Boolean(getLocalAppSessionId()),
    sqlMode: isClientSqlReadMode(),
    startedAt: new Date().toISOString(),
  });
}

export function logCarerApiForbiddenAudit(input: {
  action: string;
  route: string;
  method: string;
  status: number;
  responseBody?: unknown;
  role?: string | null;
  carerUid?: string | null;
  coadminUid?: string | null;
  requestedCoadminUid?: string | null;
  allowedRoles?: string[] | null;
  authPath?: string | null;
  reason: string;
  userVisible: boolean;
}) {
  console.info('[CARER_API_FORBIDDEN_AUDIT]', input);
}

export function logCarerInternalErrorSuppressed(input: {
  action: string;
  message: string;
  sqlMode: boolean;
  firebaseBlocked: boolean;
  userVisible: false;
  replacementMessage?: string | null;
}) {
  console.info('[CARER_INTERNAL_ERROR_SUPPRESSED]', input);
}

export function logCarerFirebaseLeftoverAudit(input: {
  action: string;
  file: string;
  function: string;
  operation: string;
  sqlMode: boolean;
  firestoreAttempted: boolean;
  blocked: boolean;
  userVisible: boolean;
}) {
  console.info('[CARER_FIREBASE_LEFTOVER_AUDIT]', input);
}

export function isCarerForbiddenMessage(message: string) {
  const normalized = String(message || '').trim().toLowerCase();
  return (
    normalized === 'forbidden.' ||
    normalized === 'forbidden' ||
    normalized.includes('forbidden:') ||
    normalized.includes('outside your scope')
  );
}

export function friendlyCarerForbiddenMessage(action: string) {
  return `You don't have permission for "${action}". Contact your coadmin if you need access.`;
}
