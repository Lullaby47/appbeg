import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid, type ApiUser } from '@/lib/firebase/apiAuth';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';
import {
  deletePaymentListener,
  getPaymentListenerForCoadmin,
  normalizePaymentListenerProvider,
  normalizePort,
  notifyPaymentListenerConfigChanged,
  publicPaymentListener,
  updatePaymentListener,
} from '@/lib/sql/paymentListeners';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/payment-listeners/[id]';

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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }
  if (!isDatabaseUrlConfigured()) {
    return apiError('Payment listeners are unavailable right now.', 503);
  }

  const { id } = await context.params;
  const listenerId = cleanText(id);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const coadminUid = resolveCoadminUid(auth.user, cleanText(body.coadminUid));
  if (!coadminUid || !listenerId) {
    return apiError('Forbidden.', 403);
  }

  const existing = await getPaymentListenerForCoadmin({ coadminUid, listenerId });
  if (!existing) {
    return apiError('Listener not found.', 404);
  }

  const provider =
    body.provider === undefined ? undefined : normalizePaymentListenerProvider(body.provider);
  if (body.provider !== undefined && !provider) {
    return apiError('Provider must be gmail or outlook.', 400);
  }
  const email = body.email === undefined ? undefined : cleanText(body.email).toLowerCase();
  if (email !== undefined && !validEmail(email)) {
    return apiError('A valid email is required.', 400);
  }
  const label = body.label === undefined ? undefined : cleanText(body.label);
  if (label !== undefined && !label) {
    return apiError('Listener label is required.', 400);
  }

  try {
    const listener = await updatePaymentListener({
      coadminUid,
      listenerId,
      label,
      provider: provider || undefined,
      email,
      imapHost: body.imapHost === undefined ? undefined : cleanText(body.imapHost),
      imapPort: body.imapPort === undefined ? undefined : normalizePort(body.imapPort),
      useSsl: body.useSsl === undefined ? undefined : Boolean(body.useSsl),
      password: cleanText(body.password) ? String(body.password) : undefined,
      autoLoad: body.autoLoad === undefined ? undefined : Boolean(body.autoLoad),
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
    });
    if (!listener) {
      return apiError('Listener not found.', 404);
    }
    console.info('[PAYMENT_LISTENER_UPDATE]', {
      route: ROUTE,
      coadminUid,
      listenerId,
      provider: listener.provider,
      enabled: listener.enabled,
      autoLoad: listener.autoLoad,
      ok: true,
    });
    void notifyPaymentListenerConfigChanged({ coadminUid, listenerId, action: 'updated' });
    return NextResponse.json({
      success: true,
      listener: publicPaymentListener(listener),
      message: listener.enabled ? 'Listener saved' : 'Listener disabled',
      source: 'postgres',
      firestore_fallback: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update listener.';
    console.info('[PAYMENT_LISTENER_UPDATE]', {
      route: ROUTE,
      coadminUid,
      listenerId,
      ok: false,
      error: message,
    });
    return apiError(message, /PAYMENT_LISTENER_ENCRYPTION_KEY/i.test(message) ? 500 : 400);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }
  if (!isDatabaseUrlConfigured()) {
    return apiError('Payment listeners are unavailable right now.', 503);
  }

  const { id } = await context.params;
  const listenerId = cleanText(id);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const requestedFromQuery = cleanText(new URL(request.url).searchParams.get('coadminUid'));
  const coadminUid = resolveCoadminUid(auth.user, cleanText(body.coadminUid) || requestedFromQuery);
  if (!coadminUid || !listenerId) {
    return apiError('Forbidden.', 403);
  }

  const ok = await deletePaymentListener({ coadminUid, listenerId });
  console.info('[PAYMENT_LISTENER_DELETE]', {
    route: ROUTE,
    coadminUid,
    listenerId,
    ok,
  });
  if (!ok) {
    return apiError('Listener not found.', 404);
  }
  void notifyPaymentListenerConfigChanged({ coadminUid, listenerId, action: 'deleted' });
  return NextResponse.json({
    success: true,
    listenerId,
    message: 'Listener deleted',
    source: 'postgres',
    firestore_fallback: false,
  });
}
