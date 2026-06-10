'use client';

import {
  ensureAppSessionBootstrapped,
  getAppSessionRequestHeaders,
  getLocalAppSessionId,
} from '@/features/auth/appSession';
import { discardStalePlayerSessionIdForRole, getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { auth } from '@/lib/firebase/client';

async function resolveStaffRole() {
  const cached = getCachedSessionUser();
  if (cached?.role) {
    return String(cached.role).toLowerCase();
  }
  const sessionUser = await getSessionUserOnce().catch(() => null);
  return String(sessionUser?.role || '').toLowerCase();
}

/**
 * App-session auth for staff/coadmin/admin API calls.
 * Never requires X-Player-Session-Id. Bearer token is optional when app session is present.
 */
export async function getStaffAppSessionApiHeaders(contentType = false) {
  await ensureAppSessionBootstrapped();

  const role = await resolveStaffRole();
  if (role && role !== 'player') {
    discardStalePlayerSessionIdForRole(role, 'staff_api_headers');
  }

  const appSessionHeaders = getAppSessionRequestHeaders();
  const hasAppSession = Boolean(appSessionHeaders['X-App-Session-Id']);
  const currentUser = auth.currentUser;

  if (!hasAppSession && !currentUser) {
    throw new Error('Session changed. Please refresh.');
  }

  const headers: Record<string, string> = {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    ...appSessionHeaders,
  };

  if (currentUser) {
    headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
  }

  return headers;
}

export function staffApiHeaderFlags(headers: Record<string, string>) {
  return {
    hasAppSessionId: Boolean(headers['X-App-Session-Id'] || getLocalAppSessionId()),
    hasPlayerSessionId: Boolean(headers['X-Player-Session-Id'] || getLocalPlayerSessionId()),
    usesAuthorizationHeader: Boolean(headers.Authorization),
    usesPlayerSessionHeader: Boolean(headers['X-Player-Session-Id']),
  };
}
