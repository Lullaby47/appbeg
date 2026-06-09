'use client';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { isClientSqlReadMode as isSqlReadModeFromFlags } from '@/lib/client/sqlPublicFlags';

export function isClientSqlReadMode() {
  return isSqlReadModeFromFlags() || Boolean(getLocalAppSessionId());
}

export function logClientFirestoreSkipped(feature: string, extra?: Record<string, unknown>) {
  console.info('[CLIENT_FIRESTORE]', {
    client_firestore_skipped: true,
    reason: 'sql_read_mode',
    feature,
    ...extra,
  });
}
