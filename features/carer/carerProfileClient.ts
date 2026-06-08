import { getAppSessionRequestHeaders } from '@/features/auth/appSession';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import { getFirebaseApiHeaders } from '@/lib/firebase/apiClient';

export type CarerDashboardProfileClient = {
  uid: string;
  username: string;
  role: string;
  coadminUid: string | null;
  automationAgentId: string | null;
  paymentQrUrl: string;
  paymentQrPublicId: string;
  paymentDetails: string;
  cashBoxNpr: number;
  source: 'postgres' | 'fallback';
};

export async function fetchCarerDashboardProfile(): Promise<CarerDashboardProfileClient | null> {
  const sessionUser = getCachedSessionUser()?.uid
    ? getCachedSessionUser()
    : await getSessionUserOnce();
  if (!sessionUser?.uid || String(sessionUser.role || '').toLowerCase() !== 'carer') {
    return null;
  }

  try {
    const headers = {
      ...(await getFirebaseApiHeaders(false)),
      ...getAppSessionRequestHeaders(),
    };
    const response = await fetch('/api/carer/profile', {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as CarerDashboardProfileClient;
    if (!payload?.uid) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
