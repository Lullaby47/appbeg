import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid, type ApiUser } from '@/lib/firebase/apiAuth';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';
import {
  createPaymentListener,
  listPaymentListeners,
  normalizePaymentListenerProvider,
  notifyPaymentListenerConfigChanged,
  publicPaymentListener,
  defaultPaymentListenerValues,
  normalizePort,
} from '@/lib/sql/paymentListeners';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/payment-listeners';

function resolveCoadminUid(authUser: ApiUser, requestedCoadminUid: string) {
  if (authUser.role === 'coadmin') {
    return authUser.uid;
  }
  if (authUser.role === 'admin') {
    return requestedCoadminUid || scopedCoadminUid(authUser) || '';
  }
  return '';
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function GET(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }
  if (!isDatabaseUrlConfigured()) {
    return apiError('Payment listeners are unavailable right now.', 503);
  }

  const requestedCoadminUid = cleanText(new URL(request.url).searchParams.get('coadminUid'));
  const coadminUid = resolveCoadminUid(auth.user, requestedCoadminUid);
  if (!coadminUid) {
    return apiError('Forbidden.', 403);
  }

  const listeners = await listPaymentListeners(coadminUid);
  return NextResponse.json({
    listeners: listeners.map((listener) => publicPaymentListener(listener)),
    source: 'postgres',
    firestore_fallback: false,
  });
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }
  if (!isDatabaseUrlConfigured()) {
    return apiError('Payment listeners are unavailable right now.', 503);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const coadminUid = resolveCoadminUid(auth.user, cleanText(body.coadminUid));
  if (!coadminUid) {
    return apiError('Forbidden.', 403);
  }

  const provider = normalizePaymentListenerProvider(body.provider);
  if (!provider) {
    return apiError('Provider must be gmail or outlook.', 400);
  }
  if (provider === 'outlook') {
    return apiError('Use Connect Outlook to authorize Outlook listeners.', 400);
  }
  const defaults = defaultPaymentListenerValues(provider);
  const label = cleanText(body.label);
  const email = cleanText(body.email).toLowerCase();
  const password = String(body.password || '');
  if (!label) {
    return apiError('Listener label is required.', 400);
  }
  if (!validEmail(email)) {
    return apiError('A valid email is required.', 400);
  }
  if (!password.trim()) {
    return apiError('Password is required.', 400);
  }

  try {
    const listener = await createPaymentListener({
      coadminUid,
      label,
      provider,
      email,
      imapHost: cleanText(body.imapHost) || defaults.imapHost,
      imapPort: normalizePort(body.imapPort || defaults.imapPort),
      useSsl: body.useSsl === undefined ? defaults.useSsl : Boolean(body.useSsl),
      password,
      autoLoad: Boolean(body.autoLoad),
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    });
    console.info('[PAYMENT_LISTENER_CREATE]', {
      route: ROUTE,
      coadminUid,
      listenerId: listener.id,
      provider,
      email,
      ok: true,
    });
    void notifyPaymentListenerConfigChanged({
      coadminUid,
      listenerId: listener.id,
      action: 'created',
    });
    return NextResponse.json({
      success: true,
      listener: publicPaymentListener(listener),
      message: 'Listener saved',
      source: 'postgres',
      firestore_fallback: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save listener.';
    console.info('[PAYMENT_LISTENER_CREATE]', {
      route: ROUTE,
      coadminUid,
      provider,
      email,
      ok: false,
      error: message,
    });
    return apiError(message, /encryption|PAYMENT_LISTENER_ENCRYPTION_KEY/i.test(message) ? 500 : 400);
  }
}
