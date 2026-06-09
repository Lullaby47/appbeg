'use client';

import { getLocalAppSessionId } from '@/features/auth/appSession';

export function isClientSqlReadMode() {
  return (
    process.env.NEXT_PUBLIC_SQL_PLAYER_LOGIN === '1' ||
    process.env.NEXT_PUBLIC_SQL_LOGIN_FIRST === '1' ||
    process.env.NEXT_PUBLIC_PLAYER_REQUESTS_SQL_READ === '1' ||
    process.env.NEXT_PUBLIC_CARER_TASKS_SQL_READ === '1' ||
    process.env.NEXT_PUBLIC_AUTOMATION_JOBS_SQL_READ === '1' ||
    Boolean(getLocalAppSessionId())
  );
}

export function logClientFirestoreSkipped(feature: string, extra?: Record<string, unknown>) {
  console.info('[CLIENT_FIRESTORE]', {
    client_firestore_skipped: true,
    reason: 'sql_read_mode',
    feature,
    ...extra,
  });
}
