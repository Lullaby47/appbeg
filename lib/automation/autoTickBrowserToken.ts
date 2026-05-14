import { createHmac, timingSafeEqual } from 'crypto';

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 2 * 60 * 1000;

export type AutoTickBrowserTokenPayload = {
  v: number;
  carerUid: string;
  username: string | null;
  automationAgentId: string;
  iat: number;
  exp: number;
};

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function browserTokenSecret() {
  return (
    String(process.env.CARER_AUTOMATION_BROWSER_TICK_TOKEN_SECRET || '').trim() ||
    String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim()
  );
}

function signPayload(encodedPayload: string, secret: string) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function createAutoTickBrowserToken(input: {
  carerUid: string;
  username?: string | null;
  automationAgentId: string;
  ttlMs?: number;
}) {
  const secret = browserTokenSecret();
  if (!secret) {
    throw new Error('Browser auto-tick token secret is not configured.');
  }
  const now = Date.now();
  const payload: AutoTickBrowserTokenPayload = {
    v: TOKEN_VERSION,
    carerUid: input.carerUid,
    username: input.username || null,
    automationAgentId: input.automationAgentId,
    iat: now,
    exp: now + Math.max(15_000, Math.min(input.ttlMs || DEFAULT_TTL_MS, 5 * 60 * 1000)),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return {
    token: `${encodedPayload}.${signPayload(encodedPayload, secret)}`,
    expiresAt: payload.exp,
  };
}

export function verifyAutoTickBrowserToken(token: string):
  | { ok: true; payload: AutoTickBrowserTokenPayload }
  | { ok: false; reason: string } {
  const secret = browserTokenSecret();
  if (!secret) {
    return { ok: false, reason: 'token_secret_missing' };
  }
  const [encodedPayload, signature] = String(token || '').trim().split('.');
  if (!encodedPayload || !signature) {
    return { ok: false, reason: 'malformed_token' };
  }
  const expected = signPayload(encodedPayload, secret);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: 'invalid_signature' };
  }
  let payload: AutoTickBrowserTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as AutoTickBrowserTokenPayload;
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (payload.v !== TOKEN_VERSION) {
    return { ok: false, reason: 'invalid_version' };
  }
  if (!payload.carerUid || !payload.automationAgentId || !payload.exp) {
    return { ok: false, reason: 'missing_claims' };
  }
  if (payload.exp <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}
