import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type PaymentListenerProvider = 'gmail' | 'outlook';
export type PaymentListenerAuthType = 'password' | 'oauth';

export type PaymentListener = {
  id: string;
  coadminUid: string;
  label: string;
  provider: PaymentListenerProvider;
  authType: PaymentListenerAuthType;
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

export type PaymentListenerSecret = PaymentListener & {
  encryptedPassword: string;
  encryptedRefreshToken: string;
};

export type PaymentListenerNotifyAction = 'created' | 'updated' | 'deleted' | 'tested';

const NOTIFY_CHANNEL = 'payment_listener_config_changed';
const ENCRYPTION_PREFIX = 'v1';
const TEST_TIMEOUT_MS = 12_000;
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';
const MICROSOFT_GRAPH_MESSAGES_TEST_URL =
  'https://graph.microsoft.com/v1.0/me/messages?$top=1';

type ImapFailureKind =
  | 'wrong_credentials_or_app_password_required'
  | 'basic_auth_blocked'
  | 'incorrect_imap_configuration'
  | 'connection_failed'
  | 'code_bug_or_unexpected_response';

class ImapLoginError extends Error {
  rawImapResponse: string;
  failureKind: ImapFailureKind;

  constructor(message: string, rawImapResponse: string, failureKind: ImapFailureKind) {
    super(message);
    this.name = 'ImapLoginError';
    this.rawImapResponse = rawImapResponse;
    this.failureKind = failureKind;
  }
}

class MicrosoftGraphError extends Error {
  status: number;
  rawResponse: string;

  constructor(message: string, status: number, rawResponse: string) {
    super(message);
    this.name = 'MicrosoftGraphError';
    this.status = status;
    this.rawResponse = rawResponse;
  }
}

function hasOuterWhitespace(value: string) {
  return value.length > 0 && value !== value.trim();
}

export const PAYMENT_LISTENER_PROVIDER_DEFAULTS: Record<
  PaymentListenerProvider,
  { imapHost: string; imapPort: number; useSsl: boolean }
> = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, useSsl: true },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, useSsl: true },
};

/*
 * Coadmin-agent deployment note:
 * - Local development agent reads these rows from the local/dev DATABASE_URL.
 * - VPS agent reads the same table from production DATABASE_URL.
 * - The code path is identical; only environment variables change between local and VPS.
 * Agents should LISTEN on payment_listener_config_changed and also poll updated_at as fallback.
 */

function providerDefault(provider: PaymentListenerProvider) {
  return PAYMENT_LISTENER_PROVIDER_DEFAULTS[provider];
}

export function normalizePaymentListenerProvider(value: unknown): PaymentListenerProvider | null {
  const provider = cleanText(value).toLowerCase();
  return provider === 'gmail' || provider === 'outlook' ? provider : null;
}

export function defaultPaymentListenerValues(provider: PaymentListenerProvider) {
  return providerDefault(provider);
}

function normalizePaymentListenerAuthType(value: unknown): PaymentListenerAuthType {
  return cleanText(value).toLowerCase() === 'oauth' ? 'oauth' : 'password';
}

function encryptionKey() {
  const raw = cleanText(process.env.PAYMENT_LISTENER_ENCRYPTION_KEY);
  if (!raw) {
    throw new Error('PAYMENT_LISTENER_ENCRYPTION_KEY is required.');
  }

  const hex = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : null;
  if (hex?.length === 32) {
    return hex;
  }

  const base64 = /^[A-Za-z0-9+/=]+$/.test(raw) ? Buffer.from(raw, 'base64') : null;
  if (base64?.length === 32) {
    return base64;
  }

  return createHash('sha256').update(raw).digest();
}

export function encryptPaymentListenerPassword(password: string) {
  const cleanPassword = String(password || '');
  if (!cleanPassword) {
    throw new Error('Password is required.');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(cleanPassword, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_PREFIX,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function encryptPaymentListenerSecret(secret: string) {
  return encryptPaymentListenerPassword(secret);
}

export function decryptPaymentListenerPassword(encryptedPassword: string) {
  const [version, ivText, tagText, encryptedText] = cleanText(encryptedPassword).split(':');
  if (version !== ENCRYPTION_PREFIX || !ivText || !tagText || !encryptedText) {
    throw new Error('Stored listener password is not decryptable.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivText, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function decryptPaymentListenerSecret(encryptedSecret: string) {
  return decryptPaymentListenerPassword(encryptedSecret);
}

function microsoftOAuthConfig() {
  const clientId = cleanText(process.env.MICROSOFT_CLIENT_ID);
  const clientSecret = cleanText(process.env.MICROSOFT_CLIENT_SECRET);
  const redirectUri = cleanText(process.env.MICROSOFT_REDIRECT_URI);
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Microsoft OAuth is not configured.');
  }
  return { clientId, clientSecret, redirectUri };
}

function mapRow(row: Record<string, unknown>, includeSecret = false): PaymentListener | PaymentListenerSecret {
  const provider = normalizePaymentListenerProvider(row.provider) || 'gmail';
  const mapped: PaymentListener = {
    id: cleanText(row.id),
    coadminUid: cleanText(row.coadmin_uid),
    label: cleanText(row.label),
    provider,
    authType: normalizePaymentListenerAuthType(row.auth_type),
    email: cleanText(row.email),
    imapHost: cleanText(row.imap_host),
    imapPort: Number(row.imap_port) || 993,
    useSsl: Boolean(row.use_ssl),
    microsoftUserId: cleanText(row.microsoft_user_id) || null,
    tokenExpiresAt: toIsoString(row.token_expires_at),
    autoLoad: Boolean(row.auto_load),
    enabled: Boolean(row.enabled),
    lastCheckedAt: toIsoString(row.last_checked_at),
    lastSuccessAt: toIsoString(row.last_success_at),
    lastError: cleanText(row.last_error) || null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  if (!includeSecret) {
    return mapped;
  }
  return {
    ...mapped,
    encryptedPassword: cleanText(row.encrypted_password),
    encryptedRefreshToken: cleanText(row.encrypted_refresh_token),
  };
}

export function publicPaymentListener(listener: PaymentListener | PaymentListenerSecret) {
  return {
    id: listener.id,
    coadminUid: listener.coadminUid,
    label: listener.label,
    provider: listener.provider,
    authType: listener.authType,
    email: listener.email,
    imapHost: listener.imapHost,
    imapPort: listener.imapPort,
    useSsl: listener.useSsl,
    microsoftUserId: listener.microsoftUserId,
    tokenExpiresAt: listener.tokenExpiresAt,
    autoLoad: listener.autoLoad,
    enabled: listener.enabled,
    lastCheckedAt: listener.lastCheckedAt,
    lastSuccessAt: listener.lastSuccessAt,
    lastError: listener.lastError,
    createdAt: listener.createdAt,
    updatedAt: listener.updatedAt,
  };
}

export async function listPaymentListeners(coadminUid: string) {
  const db = getPlayerMirrorPool();
  const cleanCoadminUid = cleanText(coadminUid);
  if (!db || !cleanCoadminUid) {
    return [];
  }
  const result = await db.query(
    `
      SELECT id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
             auth_type, microsoft_user_id, token_expires_at, auto_load, enabled,
             last_checked_at, last_success_at, last_error, created_at, updated_at
      FROM public.coadmin_payment_listeners
      WHERE coadmin_uid = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC
    `,
    [cleanCoadminUid]
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>) as PaymentListener);
}

export async function createPaymentListener(input: {
  coadminUid: string;
  label: string;
  provider: PaymentListenerProvider;
  email: string;
  imapHost?: string;
  imapPort?: number;
  useSsl?: boolean;
  password: string;
  autoLoad?: boolean;
  enabled?: boolean;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const defaults = providerDefault(input.provider);
  const label = cleanText(input.label);
  const email = cleanText(input.email).toLowerCase();
  const imapHost = cleanText(input.imapHost) || defaults.imapHost;
  const imapPort = normalizePort(input.imapPort ?? defaults.imapPort);
  if (!db || !coadminUid) {
    throw new Error('Database is unavailable.');
  }
  if (!label || !email) {
    throw new Error('Label and email are required.');
  }

  const result = await db.query(
    `
      INSERT INTO public.coadmin_payment_listeners (
        coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
        auth_type, encrypted_password, auto_load, enabled, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'password', $8, $9, $10, now())
      RETURNING id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
                auth_type, microsoft_user_id, token_expires_at, auto_load, enabled,
                last_checked_at, last_success_at, last_error, created_at, updated_at
    `,
    [
      coadminUid,
      label,
      input.provider,
      email,
      imapHost,
      imapPort,
      input.useSsl ?? defaults.useSsl,
      encryptPaymentListenerPassword(input.password),
      Boolean(input.autoLoad),
      input.enabled ?? true,
    ]
  );
  return mapRow(result.rows[0] as Record<string, unknown>) as PaymentListener;
}

export async function getPaymentListenerForCoadmin(input: {
  coadminUid: string;
  listenerId: string;
  includeSecret?: boolean;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const listenerId = cleanText(input.listenerId);
  if (!db || !coadminUid || !listenerId) {
    return null;
  }
  const result = await db.query(
    `
      SELECT id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
             auth_type, encrypted_password, encrypted_refresh_token, microsoft_user_id,
             token_expires_at, auto_load, enabled, last_checked_at, last_success_at,
             last_error, created_at, updated_at
      FROM public.coadmin_payment_listeners
      WHERE id = $1::uuid AND coadmin_uid = $2 AND deleted_at IS NULL
      LIMIT 1
    `,
    [listenerId, coadminUid]
  );
  if (!result.rows[0]) {
    return null;
  }
  return mapRow(result.rows[0] as Record<string, unknown>, Boolean(input.includeSecret));
}

export async function updatePaymentListener(input: {
  coadminUid: string;
  listenerId: string;
  label?: string;
  provider?: PaymentListenerProvider;
  email?: string;
  imapHost?: string;
  imapPort?: number;
  useSsl?: boolean;
  password?: string;
  autoLoad?: boolean;
  enabled?: boolean;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const listenerId = cleanText(input.listenerId);
  if (!db || !coadminUid || !listenerId) {
    throw new Error('Database is unavailable.');
  }

  const existing = (await getPaymentListenerForCoadmin({
    coadminUid,
    listenerId,
    includeSecret: true,
  })) as PaymentListenerSecret | null;
  if (!existing) {
    return null;
  }

  const provider = input.provider || existing.provider;
  const defaults = providerDefault(provider);
  const label = input.label !== undefined ? cleanText(input.label) : existing.label;
  const email = input.email !== undefined ? cleanText(input.email).toLowerCase() : existing.email;
  const imapHost =
    input.imapHost !== undefined ? cleanText(input.imapHost) || defaults.imapHost : existing.imapHost;
  const imapPort = input.imapPort !== undefined ? normalizePort(input.imapPort) : existing.imapPort;
  if (!label || !email) {
    throw new Error('Label and email are required.');
  }

  const encryptedPassword = cleanText(input.password)
    ? encryptPaymentListenerPassword(String(input.password))
    : existing.encryptedPassword;

  const result = await db.query(
    `
      UPDATE public.coadmin_payment_listeners
      SET label = $3,
          provider = $4,
          email = $5,
          imap_host = $6,
          imap_port = $7,
          use_ssl = $8,
          auth_type = CASE WHEN $4 = 'outlook' AND auth_type = 'oauth' THEN 'oauth' ELSE 'password' END,
          encrypted_password = $9,
          auto_load = $10,
          enabled = $11,
          updated_at = now()
      WHERE id = $1::uuid AND coadmin_uid = $2 AND deleted_at IS NULL
      RETURNING id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
                auth_type, microsoft_user_id, token_expires_at, auto_load, enabled,
                last_checked_at, last_success_at, last_error, created_at, updated_at
    `,
    [
      listenerId,
      coadminUid,
      label,
      provider,
      email,
      imapHost,
      imapPort,
      input.useSsl ?? existing.useSsl,
      encryptedPassword,
      input.autoLoad ?? existing.autoLoad,
      input.enabled ?? existing.enabled,
    ]
  );
  if (!result.rows[0]) {
    return null;
  }
  return mapRow(result.rows[0] as Record<string, unknown>) as PaymentListener;
}

export async function upsertOutlookOAuthPaymentListener(input: {
  coadminUid: string;
  listenerId?: string;
  label?: string;
  email: string;
  microsoftUserId: string;
  refreshToken: string;
  tokenExpiresAt?: Date | null;
  autoLoad?: boolean;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const listenerId = cleanText(input.listenerId);
  const email = cleanText(input.email).toLowerCase();
  const label = cleanText(input.label) || email || 'Outlook Listener';
  const microsoftUserId = cleanText(input.microsoftUserId);
  if (!db || !coadminUid || !email || !microsoftUserId || !input.refreshToken) {
    throw new Error('Database is unavailable.');
  }

  const defaults = providerDefault('outlook');
  const encryptedRefreshToken = encryptPaymentListenerSecret(input.refreshToken);
  const tokenExpiresAt = input.tokenExpiresAt?.toISOString() || null;
  const params = [
    coadminUid,
    listenerId || null,
    label,
    email,
    defaults.imapHost,
    defaults.imapPort,
    defaults.useSsl,
    encryptedRefreshToken,
    microsoftUserId,
    tokenExpiresAt,
    Boolean(input.autoLoad),
  ];
  const updateResult = await db.query(
    `
      UPDATE public.coadmin_payment_listeners
      SET label = $3,
          provider = 'outlook',
          email = $4,
          imap_host = $5,
          imap_port = $6,
          use_ssl = $7,
          auth_type = 'oauth',
          encrypted_password = NULL,
          encrypted_refresh_token = $8,
          microsoft_user_id = $9,
          token_expires_at = $10::timestamptz,
          auto_load = COALESCE($11::boolean, auto_load),
          enabled = TRUE,
          updated_at = now()
      WHERE coadmin_uid = $1
        AND deleted_at IS NULL
        AND (
          ($2::uuid IS NOT NULL AND id = $2::uuid)
          OR ($2::uuid IS NULL AND provider = 'outlook' AND email = $4)
          OR ($2::uuid IS NULL AND provider = 'outlook' AND microsoft_user_id = $9)
        )
      RETURNING id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
                auth_type, microsoft_user_id, token_expires_at, auto_load, enabled,
                last_checked_at, last_success_at, last_error, created_at, updated_at
    `,
    params
  );
  if (updateResult.rows[0]) {
    return mapRow(updateResult.rows[0] as Record<string, unknown>) as PaymentListener;
  }

  const insertResult = await db.query(
    `
      INSERT INTO public.coadmin_payment_listeners (
        coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
        auth_type, encrypted_password, encrypted_refresh_token, microsoft_user_id,
        token_expires_at, auto_load, enabled, updated_at
      )
      VALUES ($1, $3, 'outlook', $4, $5, $6, $7, 'oauth', NULL, $8, $9,
              $10::timestamptz, $11, TRUE, now())
      RETURNING id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
                auth_type, microsoft_user_id, token_expires_at, auto_load, enabled,
                last_checked_at, last_success_at, last_error, created_at, updated_at
    `,
    params
  );
  return mapRow(insertResult.rows[0] as Record<string, unknown>) as PaymentListener;
}

export async function deletePaymentListener(input: { coadminUid: string; listenerId: string }) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const listenerId = cleanText(input.listenerId);
  if (!db || !coadminUid || !listenerId) {
    return false;
  }
  const result = await db.query(
    `
      UPDATE public.coadmin_payment_listeners
      SET deleted_at = now(), enabled = FALSE, updated_at = now()
      WHERE id = $1::uuid AND coadmin_uid = $2 AND deleted_at IS NULL
    `,
    [listenerId, coadminUid]
  );
  return (result.rowCount || 0) > 0;
}

export async function updatePaymentListenerTestResult(input: {
  coadminUid: string;
  listenerId: string;
  ok: boolean;
  error?: string | null;
}) {
  const db = getPlayerMirrorPool();
  const coadminUid = cleanText(input.coadminUid);
  const listenerId = cleanText(input.listenerId);
  if (!db || !coadminUid || !listenerId) {
    return null;
  }
  const result = await db.query(
    `
      UPDATE public.coadmin_payment_listeners
      SET last_checked_at = now(),
          last_success_at = CASE WHEN $3::boolean THEN now() ELSE last_success_at END,
          last_error = CASE WHEN $3::boolean THEN NULL ELSE NULLIF($4, '') END,
          updated_at = now()
      WHERE id = $1::uuid AND coadmin_uid = $2 AND deleted_at IS NULL
      RETURNING id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
                auth_type, microsoft_user_id, token_expires_at, auto_load, enabled,
                last_checked_at, last_success_at, last_error, created_at, updated_at
    `,
    [listenerId, coadminUid, input.ok, cleanText(input.error)]
  );
  return result.rows[0]
    ? (mapRow(result.rows[0] as Record<string, unknown>) as PaymentListener)
    : null;
}

export async function notifyPaymentListenerConfigChanged(input: {
  coadminUid: string;
  listenerId: string;
  action: PaymentListenerNotifyAction;
}) {
  const db = getPlayerMirrorPool();
  if (!db) {
    return;
  }
  const payload = {
    coadminUid: cleanText(input.coadminUid),
    listenerId: cleanText(input.listenerId),
    action: input.action,
    ts: new Date().toISOString(),
  };
  try {
    await db.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, JSON.stringify(payload)]);
    console.info('[PAYMENT_LISTENER_NOTIFY]', { ok: true, channel: NOTIFY_CHANNEL, ...payload });
  } catch (error) {
    console.warn('[PAYMENT_LISTENER_NOTIFY]', {
      ok: false,
      channel: NOTIFY_CHANNEL,
      ...payload,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type MicrosoftTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type MicrosoftProfileResponse = {
  id?: string;
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
};

async function readMicrosoftJson(response: Response) {
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { raw, json };
}

function microsoftTokenExpiry(expiresIn: unknown) {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(Date.now() + seconds * 1000);
}

export async function exchangeMicrosoftAuthorizationCode(code: string) {
  const config = microsoftOAuthConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    scope: 'offline_access User.Read Mail.Read',
  });
  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  const { raw, json } = await readMicrosoftJson(response);
  if (!response.ok || !json.access_token || !json.refresh_token) {
    console.info('[PAYMENT_LISTENER_OAUTH_ERROR]', {
      step: 'token_exchange',
      status: response.status,
      rawMicrosoftResponse: raw,
    });
    throw new MicrosoftGraphError('Microsoft OAuth token exchange failed.', response.status, raw);
  }
  const token = json as MicrosoftTokenResponse;
  return {
    accessToken: String(token.access_token),
    refreshToken: String(token.refresh_token),
    tokenExpiresAt: microsoftTokenExpiry(token.expires_in),
  };
}

async function refreshMicrosoftAccessToken(listener: PaymentListenerSecret) {
  const config = microsoftOAuthConfig();
  const refreshToken = decryptPaymentListenerSecret(listener.encryptedRefreshToken);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: config.redirectUri,
    scope: 'offline_access User.Read Mail.Read',
  });
  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  const { raw, json } = await readMicrosoftJson(response);
  if (!response.ok || !json.access_token) {
    console.info('[PAYMENT_LISTENER_OAUTH_ERROR]', {
      step: 'refresh_token',
      listenerId: listener.id,
      status: response.status,
      rawMicrosoftResponse: raw,
    });
    throw new MicrosoftGraphError('Microsoft OAuth refresh failed.', response.status, raw);
  }
  const token = json as MicrosoftTokenResponse;
  const nextRefreshToken = cleanText(token.refresh_token) || refreshToken;
  const tokenExpiresAt = microsoftTokenExpiry(token.expires_in);
  await updateOutlookOAuthTokenMetadata({
    coadminUid: listener.coadminUid,
    listenerId: listener.id,
    refreshToken: nextRefreshToken,
    tokenExpiresAt,
  });
  return String(token.access_token);
}

export async function fetchMicrosoftProfile(accessToken: string) {
  const response = await fetch(MICROSOFT_GRAPH_ME_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const { raw, json } = await readMicrosoftJson(response);
  if (!response.ok) {
    console.info('[PAYMENT_LISTENER_OAUTH_ERROR]', {
      step: 'graph_me',
      status: response.status,
      rawMicrosoftResponse: raw,
    });
    throw new MicrosoftGraphError('Microsoft profile read failed.', response.status, raw);
  }
  const profile = json as MicrosoftProfileResponse;
  return {
    microsoftUserId: cleanText(profile.id),
    email: cleanText(profile.mail || profile.userPrincipalName).toLowerCase(),
    displayName: cleanText(profile.displayName),
  };
}

async function updateOutlookOAuthTokenMetadata(input: {
  coadminUid: string;
  listenerId: string;
  refreshToken: string;
  tokenExpiresAt: Date | null;
}) {
  const db = getPlayerMirrorPool();
  if (!db) {
    return;
  }
  await db.query(
    `
      UPDATE public.coadmin_payment_listeners
      SET encrypted_refresh_token = $3,
          token_expires_at = $4::timestamptz,
          updated_at = now()
      WHERE id = $1::uuid AND coadmin_uid = $2 AND deleted_at IS NULL
    `,
    [
      cleanText(input.listenerId),
      cleanText(input.coadminUid),
      encryptPaymentListenerSecret(input.refreshToken),
      input.tokenExpiresAt?.toISOString() || null,
    ]
  );
}

async function testMicrosoftGraphMail(listener: PaymentListenerSecret) {
  if (!listener.encryptedRefreshToken) {
    throw new Error('Outlook listener is not connected.');
  }
  const accessToken = await refreshMicrosoftAccessToken(listener);
  const response = await fetch(MICROSOFT_GRAPH_MESSAGES_TEST_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const { raw } = await readMicrosoftJson(response);
  if (!response.ok) {
    console.info('[PAYMENT_LISTENER_IMAP_ERROR]', {
      provider: 'outlook',
      authType: 'oauth',
      listenerId: listener.id,
      username: listener.email,
      graphUrl: MICROSOFT_GRAPH_MESSAGES_TEST_URL,
      ok: false,
      status: response.status,
      rawMicrosoftResponse: raw,
    });
    throw new MicrosoftGraphError('Microsoft Graph mailbox test failed.', response.status, raw);
  }
  console.info('[PAYMENT_LISTENER_IMAP_SUCCESS]', {
    provider: 'outlook',
    authType: 'oauth',
    listenerId: listener.id,
    username: listener.email,
    graphUrl: MICROSOFT_GRAPH_MESSAGES_TEST_URL,
    ok: true,
  });
}

export async function testPaymentListenerConnection(listener: PaymentListenerSecret) {
  if (listener.provider === 'outlook' && listener.authType === 'oauth') {
    console.info('[PAYMENT_LISTENER_TEST]', {
      listenerId: listener.id,
      provider: listener.provider,
      authType: listener.authType,
      username: listener.email,
      microsoftUserId: listener.microsoftUserId,
      tokenExpiresAt: listener.tokenExpiresAt,
      tokenSource: 'encrypted_refresh_token',
    });
    await testMicrosoftGraphMail(listener);
    return;
  }

  const password = decryptPaymentListenerPassword(listener.encryptedPassword);
  console.info('[PAYMENT_LISTENER_TEST]', {
    listenerId: listener.id,
    provider: listener.provider,
    host: listener.imapHost,
    port: listener.imapPort,
    ssl: listener.useSsl,
    username: listener.email,
    passwordSource: 'stored_encrypted_password_decrypted_for_imap_login',
    decryptedPasswordPresent: Boolean(password),
    decryptedPasswordLength: password.length,
    decryptedPasswordHasOuterWhitespace: hasOuterWhitespace(password),
  });
  await testImapLogin({
    host: listener.imapHost,
    port: listener.imapPort,
    useSsl: listener.useSsl,
    email: listener.email,
    password,
  });
}

export function normalizePort(value: unknown) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('IMAP port must be between 1 and 65535.');
  }
  return port;
}

function imapQuoted(value: string) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function classifyImapError(message: string) {
  if (/invalid credentials|authentication failed|login failed|\bNO\b|AUTHENTICATIONFAILED/i.test(message)) {
    return 'Invalid credentials';
  }
  return message || 'Connection failed';
}

function classifyImapFailureKind(rawResponse: string): ImapFailureKind {
  const response = cleanText(rawResponse);
  if (/LOGINDISABLED|basic auth|basic authentication|disabled/i.test(response)) {
    return 'basic_auth_blocked';
  }
  if (/AUTHENTICATIONFAILED|authentication failed|login failed|invalid credentials|\bNO\b/i.test(response)) {
    return 'wrong_credentials_or_app_password_required';
  }
  if (/certificate|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|wrong version number|socket disconnected/i.test(response)) {
    return 'incorrect_imap_configuration';
  }
  if (response) {
    return 'code_bug_or_unexpected_response';
  }
  return 'connection_failed';
}

async function testImapLogin(input: {
  host: string;
  port: number;
  useSsl: boolean;
  email: string;
  password: string;
}) {
  const host = cleanText(input.host);
  const email = cleanText(input.email);
  if (!host || !email || !input.password) {
    throw new Error('Host, email, and password are required.');
  }

  return await new Promise<void>((resolve, reject) => {
    console.info('[PAYMENT_LISTENER_TEST]', {
      host,
      port: input.port,
      ssl: input.useSsl,
      username: email,
      passwordSource: 'decrypted_stored_password',
      fullEmailUsername: email,
      outlookDefaultConfig:
        host === PAYMENT_LISTENER_PROVIDER_DEFAULTS.outlook.imapHost &&
        input.port === PAYMENT_LISTENER_PROVIDER_DEFAULTS.outlook.imapPort &&
        input.useSsl === PAYMENT_LISTENER_PROVIDER_DEFAULTS.outlook.useSsl,
    });
    const socket = input.useSsl
      ? tls.connect({ host, port: input.port, servername: host, timeout: TEST_TIMEOUT_MS })
      : net.connect({ host, port: input.port, timeout: TEST_TIMEOUT_MS });
    let buffer = '';
    let settled = false;
    let loginSent = false;
    const loginTag = 'a001';

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.end();
      if (error) {
        reject(error instanceof ImapLoginError ? error : new Error(classifyImapError(error.message)));
      } else {
        console.info('[PAYMENT_LISTENER_IMAP_SUCCESS]', {
          host,
          port: input.port,
          ssl: input.useSsl,
          username: email,
          ok: true,
        });
        resolve();
      }
    };

    const failWithLoggedError = (rawResponse: string, fallbackMessage?: string) => {
      const failureKind = classifyImapFailureKind(rawResponse || fallbackMessage || '');
      const frontendMessage = classifyImapError(rawResponse || fallbackMessage || '');
      console.info('[PAYMENT_LISTENER_IMAP_ERROR]', {
        host,
        port: input.port,
        ssl: input.useSsl,
        username: email,
        ok: false,
        failureKind,
        rawImapAuthResponse: rawResponse || null,
        error: fallbackMessage || frontendMessage,
      });
      finish(new ImapLoginError(frontendMessage, rawResponse, failureKind));
    };

    socket.setTimeout(TEST_TIMEOUT_MS);
    socket.on('timeout', () => failWithLoggedError(buffer, 'Connection timed out'));
    socket.on('error', (error) => failWithLoggedError(buffer, error.message));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!loginSent && /^\* OK/i.test(line)) {
          loginSent = true;
          socket.write(`${loginTag} LOGIN ${imapQuoted(email)} ${imapQuoted(input.password)}\r\n`);
          continue;
        }
        if (line.startsWith(`${loginTag} OK`)) {
          socket.write('a002 LOGOUT\r\n');
          finish();
          return;
        }
        if (line.startsWith(`${loginTag} NO`) || line.startsWith(`${loginTag} BAD`)) {
          failWithLoggedError(line);
          return;
        }
      }
    });
  });
}
