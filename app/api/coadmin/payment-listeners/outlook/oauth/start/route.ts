import { NextResponse } from 'next/server';

import { apiError, requireApiUser, scopedCoadminUid, type ApiUser } from '@/lib/firebase/apiAuth';
import { encodePaymentListenerMicrosoftOAuthState } from '@/lib/server/paymentListenerMicrosoftOAuth';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';
import { isOutlookOAuthPaymentListenerEnabled } from '@/lib/sql/paymentListeners';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const SCOPES = ['offline_access', 'User.Read', 'Mail.Read'];

function resolveCoadminUid(authUser: ApiUser, requestedCoadminUid: string) {
  if (authUser.role === 'coadmin') {
    return authUser.uid;
  }
  if (authUser.role === 'admin') {
    return requestedCoadminUid || scopedCoadminUid(authUser) || '';
  }
  return '';
}

export async function GET(request: Request) {
  if (!isOutlookOAuthPaymentListenerEnabled()) {
    return apiError('Outlook OAuth listeners are disabled.', 404);
  }
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return auth.response;
  }
  if (!isDatabaseUrlConfigured()) {
    return apiError('Payment listeners are unavailable right now.', 503);
  }

  const url = new URL(request.url);
  const coadminUid = resolveCoadminUid(auth.user, cleanText(url.searchParams.get('coadminUid')));
  if (!coadminUid) {
    return apiError('Forbidden.', 403);
  }

  const clientId = cleanText(process.env.MICROSOFT_CLIENT_ID);
  const redirectUri = cleanText(process.env.MICROSOFT_REDIRECT_URI);
  if (!clientId || !redirectUri || !cleanText(process.env.MICROSOFT_CLIENT_SECRET)) {
    return apiError('Microsoft OAuth is not configured.', 500);
  }

  const state = encodePaymentListenerMicrosoftOAuthState({
    coadminUid,
    listenerId: cleanText(url.searchParams.get('listenerId')) || undefined,
    label: cleanText(url.searchParams.get('label')) || undefined,
    autoLoad: url.searchParams.get('autoLoad') === 'true',
  });
  const authUrl = new URL(MICROSOFT_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');

  console.info('[PAYMENT_LISTENER_OAUTH_START]', {
    coadminUid,
    listenerId: cleanText(url.searchParams.get('listenerId')) || null,
    scopes: SCOPES,
  });
  if (url.searchParams.get('response') === 'json') {
    return NextResponse.json({ url: authUrl.toString() });
  }
  return NextResponse.redirect(authUrl);
}
