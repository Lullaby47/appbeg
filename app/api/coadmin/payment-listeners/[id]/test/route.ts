import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid, type ApiUser } from '@/lib/firebase/apiAuth';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';
import {
  getPaymentListenerForCoadmin,
  notifyPaymentListenerConfigChanged,
  publicPaymentListener,
  testPaymentListenerConnection,
  updatePaymentListenerTestResult,
  type PaymentListenerSecret,
} from '@/lib/sql/paymentListeners';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

const ROUTE = '/api/coadmin/payment-listeners/[id]/test';
const IS_DEVELOPMENT = process.env.NODE_ENV !== 'production';

function resolveCoadminUid(authUser: ApiUser, requestedCoadminUid: string) {
  if (authUser.role === 'coadmin') {
    return authUser.uid;
  }
  if (authUser.role === 'admin') {
    return requestedCoadminUid || scopedCoadminUid(authUser) || '';
  }
  return '';
}

function paymentListenerTestErrorDetails(error: unknown) {
  const details = error as {
    rawImapResponse?: unknown;
    rawResponse?: unknown;
    failureKind?: unknown;
    status?: unknown;
  };
  const rawResponse =
    typeof details.rawImapResponse === 'string' && details.rawImapResponse.trim()
      ? details.rawImapResponse
      : typeof details.rawResponse === 'string' && details.rawResponse.trim()
        ? details.rawResponse
        : null;
  return {
    rawImapAuthResponse: rawResponse,
    failureKind:
      typeof details.failureKind === 'string' && details.failureKind.trim()
        ? details.failureKind
        : null,
    upstreamStatus: typeof details.status === 'number' ? details.status : null,
  };
}

export async function POST(
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

  const listener = (await getPaymentListenerForCoadmin({
    coadminUid,
    listenerId,
    includeSecret: true,
  })) as PaymentListenerSecret | null;
  if (!listener) {
    return apiError('Listener not found.', 404);
  }

  try {
    await testPaymentListenerConnection(listener);
    const updated = await updatePaymentListenerTestResult({ coadminUid, listenerId, ok: true });
    console.info('[PAYMENT_LISTENER_TEST]', {
      route: ROUTE,
      coadminUid,
      listenerId,
      provider: listener.provider,
      authType: listener.authType,
      host: listener.imapHost,
      port: listener.imapPort,
      ssl: listener.useSsl,
      username: listener.email,
      ok: true,
    });
    void notifyPaymentListenerConfigChanged({ coadminUid, listenerId, action: 'tested' });
    return NextResponse.json({
      success: true,
      message: 'Connection successful',
      listener: updated ? publicPaymentListener(updated) : publicPaymentListener(listener),
      source: 'postgres',
      firestore_fallback: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed';
    const errorDetails = paymentListenerTestErrorDetails(error);
    const updated = await updatePaymentListenerTestResult({
      coadminUid,
      listenerId,
      ok: false,
      error: message,
    });
    console.info('[PAYMENT_LISTENER_TEST]', {
      route: ROUTE,
      coadminUid,
      listenerId,
      provider: listener.provider,
      authType: listener.authType,
      host: listener.imapHost,
      port: listener.imapPort,
      ssl: listener.useSsl,
      username: listener.email,
      ok: false,
      ...errorDetails,
      error: message,
    });
    void notifyPaymentListenerConfigChanged({ coadminUid, listenerId, action: 'tested' });
    return NextResponse.json(
      {
        success: false,
        error: message,
        message,
        listener: updated ? publicPaymentListener(updated) : publicPaymentListener(listener),
        debug: IS_DEVELOPMENT
          ? {
              rawImapAuthResponse: errorDetails.rawImapAuthResponse,
              rawMicrosoftResponse: errorDetails.rawImapAuthResponse,
              failureKind: errorDetails.failureKind,
              upstreamStatus: errorDetails.upstreamStatus,
              host: listener.imapHost,
              port: listener.imapPort,
              ssl: listener.useSsl,
              username: listener.email,
            }
          : undefined,
        source: 'postgres',
        firestore_fallback: false,
      },
      { status: /invalid credentials/i.test(message) ? 401 : 400 }
    );
  }
}
