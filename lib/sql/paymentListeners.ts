import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

import { cleanText, getPlayerMirrorPool, toIsoString } from '@/lib/sql/playerMirrorCommon';

export type PaymentListenerProvider = 'gmail' | 'outlook';

export type PaymentListener = {
  id: string;
  coadminUid: string;
  label: string;
  provider: PaymentListenerProvider;
  email: string;
  imapHost: string;
  imapPort: number;
  useSsl: boolean;
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
};

export type PaymentListenerNotifyAction = 'created' | 'updated' | 'deleted' | 'tested';

const NOTIFY_CHANNEL = 'payment_listener_config_changed';
const ENCRYPTION_PREFIX = 'v1';
const TEST_TIMEOUT_MS = 12_000;

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

function mapRow(row: Record<string, unknown>, includeSecret = false): PaymentListener | PaymentListenerSecret {
  const provider = normalizePaymentListenerProvider(row.provider) || 'gmail';
  const mapped: PaymentListener = {
    id: cleanText(row.id),
    coadminUid: cleanText(row.coadmin_uid),
    label: cleanText(row.label),
    provider,
    email: cleanText(row.email),
    imapHost: cleanText(row.imap_host),
    imapPort: Number(row.imap_port) || 993,
    useSsl: Boolean(row.use_ssl),
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
  };
}

export function publicPaymentListener(listener: PaymentListener | PaymentListenerSecret) {
  return {
    id: listener.id,
    coadminUid: listener.coadminUid,
    label: listener.label,
    provider: listener.provider,
    email: listener.email,
    imapHost: listener.imapHost,
    imapPort: listener.imapPort,
    useSsl: listener.useSsl,
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
             auto_load, enabled, last_checked_at, last_success_at, last_error,
             created_at, updated_at
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
        encrypted_password, auto_load, enabled, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      RETURNING id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
                auto_load, enabled, last_checked_at, last_success_at, last_error,
                created_at, updated_at
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
             encrypted_password, auto_load, enabled, last_checked_at, last_success_at,
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
          encrypted_password = $9,
          auto_load = $10,
          enabled = $11,
          updated_at = now()
      WHERE id = $1::uuid AND coadmin_uid = $2 AND deleted_at IS NULL
      RETURNING id, coadmin_uid, label, provider, email, imap_host, imap_port, use_ssl,
                auto_load, enabled, last_checked_at, last_success_at, last_error,
                created_at, updated_at
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
                auto_load, enabled, last_checked_at, last_success_at, last_error,
                created_at, updated_at
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

export async function testPaymentListenerConnection(listener: PaymentListenerSecret) {
  const password = decryptPaymentListenerPassword(listener.encryptedPassword);
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
    console.info('[PAYMENT_LISTENER_TEST_IMAP_AUTH_START]', {
      host,
      port: input.port,
      useSsl: input.useSsl,
      username: email,
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
        console.info('[PAYMENT_LISTENER_TEST_IMAP_AUTH_RESULT]', {
          host,
          port: input.port,
          useSsl: input.useSsl,
          username: email,
          ok: true,
        });
        resolve();
      }
    };

    const failWithLoggedError = (rawResponse: string, fallbackMessage?: string) => {
      const failureKind = classifyImapFailureKind(rawResponse || fallbackMessage || '');
      const frontendMessage = classifyImapError(rawResponse || fallbackMessage || '');
      console.info('[PAYMENT_LISTENER_TEST_IMAP_AUTH_RESULT]', {
        host,
        port: input.port,
        useSsl: input.useSsl,
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
