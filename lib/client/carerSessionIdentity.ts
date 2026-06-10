'use client';

import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { isClientSqlReadMode } from '@/lib/client/sqlReadMode';

export async function resolveSqlSessionUser() {
  const cached = getCachedSessionUser();
  if (cached?.uid) {
    return cached;
  }
  return getSessionUserOnce().catch(() => null);
}

export async function requireSqlSessionUid(expectedUid?: string | null) {
  const session = await resolveSqlSessionUser();
  const uid = String(session?.uid || '').trim();
  if (!uid) {
    throw new Error('Session changed. Please refresh.');
  }
  const expected = String(expectedUid || '').trim();
  if (expected && uid !== expected) {
    throw new Error('Session changed. Please refresh.');
  }
  return uid;
}

export function isCarerSqlSessionMode() {
  return isClientSqlReadMode();
}
