'use client';

import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId, getPlayerApiHeaders } from '@/features/auth/playerSession';
import { getStaffAppSessionApiHeaders } from '@/lib/client/staffApiHeaders';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

async function resolveClientRole() {
  const cached = getCachedSessionUser();
  if (cached?.role) {
    return String(cached.role).toLowerCase();
  }
  const sessionUser = await getSessionUserOnce().catch(() => null);
  return String(sessionUser?.role || '').toLowerCase();
}

/**
 * SQL read API headers: player routes use player session; staff/coadmin use app session only.
 */
export async function getSqlApiReadHeaders(contentType = false) {
  const role = await resolveClientRole();
  if (role === 'player') {
    return getPlayerApiHeaders(contentType);
  }
  if (role) {
    return getStaffAppSessionApiHeaders(contentType);
  }
  const appSessionId = getLocalAppSessionId();
  const playerSessionId = getLocalPlayerSessionId();
  if (appSessionId && !playerSessionId) {
    return getStaffAppSessionApiHeaders(contentType);
  }
  if (appSessionId && playerSessionId) {
    return getStaffAppSessionApiHeaders(contentType);
  }
  return getFirebaseApiHeaders(contentType);
}
