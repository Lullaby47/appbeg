'use client';

import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';

export type PaymentListenerProvider = 'gmail' | 'outlook';

export type PaymentListener = {
  id: string;
  coadminUid: string;
  label: string;
  provider: PaymentListenerProvider;
  authType: 'password' | 'oauth';
  email: string;
  imapHost: string;
  imapPort: number;
  useSsl: boolean;
  microsoftUserId: string | null;
  tokenExpiresAt: string | null;
  autoLoad: boolean;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PaymentListenerInput = {
  coadminUid?: string;
  label: string;
  provider: PaymentListenerProvider;
  email: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  useSsl?: boolean;
  autoLoad?: boolean;
  enabled?: boolean;
};

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as {
    listener?: PaymentListener;
    listeners?: PaymentListener[];
    message?: string;
    error?: string;
  };
}

export function paymentListenerDefaults(provider: PaymentListenerProvider) {
  return provider === 'gmail'
    ? { imapHost: 'imap.gmail.com', imapPort: 993, useSsl: true }
    : { imapHost: 'outlook.office365.com', imapPort: 993, useSsl: true };
}

export async function listPaymentListeners(coadminUid?: string) {
  const query = coadminUid ? `?coadminUid=${encodeURIComponent(coadminUid)}` : '';
  const response = await fetch(`/api/coadmin/payment-listeners${query}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load listeners.');
  }
  return payload.listeners || [];
}

export async function createPaymentListener(input: PaymentListenerInput) {
  const response = await fetch('/api/coadmin/payment-listeners', {
    method: 'POST',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok || !payload.listener) {
    throw new Error(payload.error || 'Failed to save listener.');
  }
  return { listener: payload.listener, message: payload.message || 'Listener saved' };
}

export async function updatePaymentListener(id: string, input: Partial<PaymentListenerInput>) {
  const response = await fetch(`/api/coadmin/payment-listeners/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok || !payload.listener) {
    throw new Error(payload.error || 'Failed to update listener.');
  }
  return { listener: payload.listener, message: payload.message || 'Listener saved' };
}

export async function deletePaymentListener(id: string, coadminUid?: string) {
  const response = await fetch(`/api/coadmin/payment-listeners/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify({ coadminUid }),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to delete listener.');
  }
  return payload.message || 'Listener deleted';
}

export async function testPaymentListener(id: string, coadminUid?: string) {
  const response = await fetch(`/api/coadmin/payment-listeners/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: await getSqlApiReadHeaders(true),
    body: JSON.stringify({ coadminUid }),
    cache: 'no-store',
  });
  const payload = await readJson(response);
  if (!response.ok || !payload.listener) {
    throw new Error(payload.error || payload.message || 'Connection failed');
  }
  return {
    listener: payload.listener,
    message: payload.message || 'Connection successful',
  };
}

export async function connectOutlookPaymentListener(input: {
  coadminUid?: string;
  listenerId?: string | null;
  label?: string;
  autoLoad?: boolean;
}) {
  const query = new URLSearchParams();
  if (input.coadminUid) query.set('coadminUid', input.coadminUid);
  if (input.listenerId) query.set('listenerId', input.listenerId);
  if (input.label) query.set('label', input.label);
  if (input.autoLoad) query.set('autoLoad', 'true');
  query.set('response', 'json');
  const response = await fetch(
    `/api/coadmin/payment-listeners/outlook/oauth/start?${query.toString()}`,
    {
      method: 'GET',
      headers: await getSqlApiReadHeaders(false),
      cache: 'no-store',
    }
  );
  const payload = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !payload.url) {
    throw new Error(payload.error || 'Failed to start Outlook connection.');
  }
  return payload.url;
}
