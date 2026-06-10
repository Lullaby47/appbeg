'use client';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId, getPlayerApiHeaders } from '@/features/auth/playerSession';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

/**
 * SQL read API headers: app-session staff/coadmin routes use app session + bearer only.
 * Player session is required only when both app and player session IDs are present.
 */
export async function getSqlApiReadHeaders(contentType = false) {
  const appSessionId = getLocalAppSessionId();
  const playerSessionId = getLocalPlayerSessionId();
  if (appSessionId && playerSessionId) {
    return getPlayerApiHeaders(contentType);
  }
  return getFirebaseApiHeaders(contentType);
}
