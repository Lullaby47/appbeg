import { NextResponse } from 'next/server';

import { decodePaymentListenerMicrosoftOAuthState } from '@/lib/server/paymentListenerMicrosoftOAuth';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';
import {
  exchangeMicrosoftAuthorizationCode,
  fetchMicrosoftProfile,
  isOutlookOAuthPaymentListenerEnabled,
  notifyPaymentListenerConfigChanged,
  upsertOutlookOAuthPaymentListener,
} from '@/lib/sql/paymentListeners';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

function coadminRedirect(request: Request, status: string, detail?: string) {
  const url = new URL('/coadmin', request.url);
  url.searchParams.set('view', 'listener-details');
  url.searchParams.set('paymentListenerOAuth', status);
  if (detail) {
    url.searchParams.set('detail', detail);
  }
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  if (!isOutlookOAuthPaymentListenerEnabled()) {
    return coadminRedirect(request, 'error', 'oauth_disabled');
  }
  if (!isDatabaseUrlConfigured()) {
    return coadminRedirect(request, 'error', 'database_unavailable');
  }

  const url = new URL(request.url);
  const error = cleanText(url.searchParams.get('error'));
  if (error) {
    console.info('[PAYMENT_LISTENER_OAUTH_CALLBACK]', {
      ok: false,
      step: 'provider_redirect',
      error,
      errorDescription: cleanText(url.searchParams.get('error_description')),
    });
    return coadminRedirect(request, 'error', error);
  }

  try {
    const state = decodePaymentListenerMicrosoftOAuthState(cleanText(url.searchParams.get('state')));
    const code = cleanText(url.searchParams.get('code'));
    if (!code) {
      throw new Error('Microsoft OAuth code is missing.');
    }

    const token = await exchangeMicrosoftAuthorizationCode(code);
    const profile = await fetchMicrosoftProfile(token.accessToken);
    if (!profile.email || !profile.microsoftUserId) {
      throw new Error('Microsoft profile did not include an email address.');
    }

    const listener = await upsertOutlookOAuthPaymentListener({
      coadminUid: state.coadminUid,
      listenerId: state.listenerId,
      label: state.label || profile.displayName || profile.email,
      email: profile.email,
      microsoftUserId: profile.microsoftUserId,
      refreshToken: token.refreshToken,
      tokenExpiresAt: token.tokenExpiresAt,
      autoLoad: state.autoLoad,
    });
    console.info('[PAYMENT_LISTENER_OAUTH_CALLBACK]', {
      ok: true,
      coadminUid: state.coadminUid,
      listenerId: listener.id,
      microsoftUserId: listener.microsoftUserId,
      email: listener.email,
    });
    void notifyPaymentListenerConfigChanged({
      coadminUid: state.coadminUid,
      listenerId: listener.id,
      action: state.listenerId ? 'updated' : 'created',
    });
    return coadminRedirect(request, 'connected');
  } catch (callbackError) {
    const message = callbackError instanceof Error ? callbackError.message : 'OAuth failed.';
    const details = callbackError as { rawResponse?: unknown; status?: unknown };
    console.info('[PAYMENT_LISTENER_OAUTH_CALLBACK]', {
      ok: false,
      error: message,
      upstreamStatus: typeof details.status === 'number' ? details.status : null,
      rawMicrosoftResponse:
        typeof details.rawResponse === 'string' ? details.rawResponse : null,
    });
    return coadminRedirect(request, 'error', 'callback_failed');
  }
}
