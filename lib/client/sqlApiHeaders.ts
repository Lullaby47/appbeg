'use client';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getPlayerApiHeaders } from '@/features/auth/playerSession';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export async function getSqlApiReadHeaders(contentType = false) {
  if (getLocalAppSessionId()) {
    return getPlayerApiHeaders(contentType);
  }
  return getFirebaseApiHeaders(contentType);
}
