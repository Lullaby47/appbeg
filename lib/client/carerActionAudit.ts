'use client';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { auth } from '@/lib/firebase/client';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

/** @deprecated prefer logCarerButtonAudit */
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

export function logCarerButtonAudit(input: {
  action: string;
  file: string;
  function: string;
  route?: string | null;
  method?: string | null;
  role?: string | null;
  authSource?: string | null;
  sqlMode?: boolean;
  firebaseUsed?: boolean;
  willCallApi?: boolean;
}) {
  console.info('[CARER_BUTTON_AUDIT]', {
    ...input,
    sqlMode: input.sqlMode ?? isClientSqlReadMode(),
    hasAppSessionId: Boolean(getLocalAppSessionId()),
    sessionUid: getCachedSessionUser()?.uid ?? null,
    firebaseUid: auth.currentUser?.uid ?? null,
  });
}

export function logCarerRouteAudit(input: {
  route: string;
  status: number;
  role?: string | null;
  authPath?: string | null;
  reason: string;
  method?: string;
  responseBody?: unknown;
}) {
  console.info('[CARER_ROUTE_AUDIT]', input);
}

export function logCarerForbiddenAudit(input: {
  route: string;
  action: string;
  role?: string | null;
  allowedRoles?: string[] | null;
  reason: string;
  method?: string;
  status?: number;
}) {
  console.info('[CARER_FORBIDDEN_AUDIT]', input);
}

export function logCarerNotAuthenticatedAudit(input: {
  action: string;
  authSource: string;
  sessionUid?: string | null;
  expectedUid?: string | null;
  firebaseUid?: string | null;
  reason: string;
  file?: string;
  function?: string;
}) {
  console.info('[CARER_NOT_AUTHENTICATED_AUDIT]', {
    ...input,
    sessionUid: input.sessionUid ?? getCachedSessionUser()?.uid ?? null,
    firebaseUid: input.firebaseUid ?? auth.currentUser?.uid ?? null,
    sqlMode: isClientSqlReadMode(),
    hasAppSessionId: Boolean(getLocalAppSessionId()),
  });
}

export function logCarerFirebaseLeftoverReport(input: {
  file: string;
  function: string;
  operation: string;
  route?: string | null;
  sqlMode: boolean;
  firestoreAttempted: boolean;
  replacementExists: boolean;
  userVisible: boolean;
  priority: 'critical' | 'high' | 'medium' | 'low';
}) {
  console.info('[CARER_FIREBASE_LEFTOVER_AUDIT]', input);
}
