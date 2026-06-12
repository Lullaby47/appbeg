import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import { cleanText } from '@/lib/sql/playerMirrorCommon';

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export type PaymentListenerMicrosoftOAuthState = {
  coadminUid: string;
  listenerId?: string;
  label?: string;
  autoLoad?: boolean;
  ts: number;
};

function stateSecret() {
  const secret = cleanText(process.env.MICROSOFT_CLIENT_SECRET);
  if (!secret) {
    throw new Error('MICROSOFT_CLIENT_SECRET is required.');
  }
  return secret;
}

function signState(payload: string) {
  return createHmac('sha256', stateSecret()).update(payload).digest('base64url');
}

export function encodePaymentListenerMicrosoftOAuthState(
  input: Omit<PaymentListenerMicrosoftOAuthState, 'ts'>
) {
  const payload = Buffer.from(
    JSON.stringify({
      coadminUid: cleanText(input.coadminUid),
      listenerId: cleanText(input.listenerId) || undefined,
      label: cleanText(input.label) || undefined,
      autoLoad: Boolean(input.autoLoad),
      ts: Date.now(),
    }),
    'utf8'
  ).toString('base64url');
  return `${payload}.${signState(payload)}`;
}

export function decodePaymentListenerMicrosoftOAuthState(
  state: string
): PaymentListenerMicrosoftOAuthState {
  const [payload, signature] = cleanText(state).split('.');
  if (!payload || !signature) {
    throw new Error('Invalid OAuth state.');
  }
  const expected = signState(payload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error('Invalid OAuth state signature.');
  }
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
    PaymentListenerMicrosoftOAuthState;
  if (!cleanText(parsed.coadminUid) || !Number.isFinite(parsed.ts)) {
    throw new Error('Invalid OAuth state payload.');
  }
  if (Date.now() - Number(parsed.ts) > STATE_MAX_AGE_MS) {
    throw new Error('OAuth state expired.');
  }
  return {
    coadminUid: cleanText(parsed.coadminUid),
    listenerId: cleanText(parsed.listenerId) || undefined,
    label: cleanText(parsed.label) || undefined,
    autoLoad: Boolean(parsed.autoLoad),
    ts: Number(parsed.ts),
  };
}
