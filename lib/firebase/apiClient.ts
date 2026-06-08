import {
  ensureAppSessionBootstrapped,
  getAppSessionRequestHeaders,
} from '@/features/auth/appSession';
import { auth } from '@/lib/firebase/client';

export type ApiAuthHeaderAction =
  | 'delete'
  | 'status'
  | 'reset_password'
  | 'create'
  | 'read'
  | 'update'
  | 'api_request';

export async function getApiAuthHeaders(
  contentType = true,
  options?: { action?: ApiAuthHeaderAction }
) {
  await ensureAppSessionBootstrapped();

  const appSessionHeaders = getAppSessionRequestHeaders();
  const hasAppSession = Boolean(appSessionHeaders['X-App-Session-Id']);
  const currentUser = auth.currentUser;
  const hasFirebaseUser = Boolean(currentUser);

  if (options?.action) {
    console.info('[ADMIN_ACTION_AUTH]', {
      action: options.action,
      hasAppSession,
      hasFirebaseUser,
    });
  }

  if (!hasAppSession && !hasFirebaseUser) {
    throw new Error('Not authenticated.');
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

export async function getFirebaseApiHeaders(contentType = true) {
  return getApiAuthHeaders(contentType);
}
