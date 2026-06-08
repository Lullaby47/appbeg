import 'server-only';

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import {
  cleanText,
  getPlayerMirrorPool,
  normalizeJson,
  runMirrorClientQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_IMPERSONATION_TTL_SECONDS = 60 * 60;

export type AppSessionRow = {
  sessionId: string;
  uid: string;
  role: string;
  coadminUid: string | null;
  username: string | null;
  deviceId: string | null;
  active: boolean;
  expiresAt: string;
  lastSeenAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  rawContext: Record<string, unknown>;
};

function mapAppSessionRow(row: Record<string, unknown>): AppSessionRow {
  const rawContext =
    row.raw_context && typeof row.raw_context === 'object' && !Array.isArray(row.raw_context)
      ? (row.raw_context as Record<string, unknown>)
      : {};
  return {
    sessionId: cleanText(row.session_id),
    uid: cleanText(row.uid),
    role: cleanText(row.role),
    coadminUid: cleanText(row.coadmin_uid) || null,
    username: cleanText(row.username) || null,
    deviceId: cleanText(row.device_id) || null,
    active: row.active === true,
    expiresAt: toIsoString(row.expires_at) || new Date(0).toISOString(),
    lastSeenAt: toIsoString(row.last_seen_at),
    endedAt: toIsoString(row.ended_at),
    endedReason: cleanText(row.ended_reason) || null,
    createdAt: toIsoString(row.created_at) || new Date(0).toISOString(),
    updatedAt: toIsoString(row.updated_at) || new Date(0).toISOString(),
    revokedAt: toIsoString(row.revoked_at),
    rawContext,
  };
}

function sessionTtlSeconds(ttlSeconds?: number) {
  const parsed = Number(ttlSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const fromEnv = Number(process.env.APP_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.trunc(fromEnv) : DEFAULT_SESSION_TTL_SECONDS;
  }
  return Math.min(Math.trunc(parsed), 90 * 24 * 60 * 60);
}

export async function createAppSessionForUser(input: {
  uid: string;
  role: string;
  coadminUid?: string | null;
  username?: string | null;
  deviceId?: string | null;
  ttlSeconds?: number;
  rawContext?: Record<string, unknown>;
  deactivatePreviousForUid?: boolean;
}) {
  const db = getPlayerMirrorPool();
  const uid = cleanText(input.uid);
  const role = cleanText(input.role).toLowerCase();
  if (!db || !uid || !role) {
    throw new Error('uid and role are required to create an app session.');
  }

  const sessionId = randomUUID();
  const ttlSeconds = sessionTtlSeconds(input.ttlSeconds);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const now = new Date();
  const coadminUid = cleanText(input.coadminUid) || null;
  const username = cleanText(input.username) || null;
  const deviceId = cleanText(input.deviceId) || null;
  const rawContext = normalizeJson(input.rawContext || {}) || {};
  const deactivatePrevious =
    input.deactivatePreviousForUid ?? role === 'player';

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (deactivatePrevious) {
      await client.query(
        `
          UPDATE public.app_sessions
          SET
            active = FALSE,
            ended_at = $2,
            ended_reason = $3,
            revoked_at = $2,
            updated_at = $2
          WHERE uid = $1
            AND active = TRUE
        `,
        [uid, now, 'replaced_by_new_login']
      );
    }

    const insertResult = await client.query(
      `
        INSERT INTO public.app_sessions (
          session_id,
          uid,
          role,
          coadmin_uid,
          username,
          device_id,
          active,
          expires_at,
          last_seen_at,
          ended_at,
          ended_reason,
          created_at,
          updated_at,
          revoked_at,
          raw_context
        )
        VALUES (
          $1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
          TRUE, $7::timestamptz, $8::timestamptz, NULL, NULL,
          $8::timestamptz, $8::timestamptz, NULL, $9::jsonb
        )
        RETURNING *
      `,
      [
        sessionId,
        uid,
        role,
        coadminUid,
        username,
        deviceId,
        expiresAt.toISOString(),
        now.toISOString(),
        JSON.stringify(rawContext),
      ]
    );

    await client.query('COMMIT');
    return mapAppSessionRow(insertResult.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type CreateImpersonationSessionInput = {
  staffUid: string;
  staffUsername: string;
  staffCoadminUid: string;
  coadminUid: string;
  coadminUsername: string;
  originalSessionId?: string | null;
  ttlSeconds?: number;
};

export async function createImpersonationSession(input: CreateImpersonationSessionInput) {
  const staffUid = cleanText(input.staffUid);
  const staffUsername = cleanText(input.staffUsername) || 'Staff';
  const staffCoadminUid = cleanText(input.staffCoadminUid);
  const coadminUid = cleanText(input.coadminUid);
  const coadminUsername = cleanText(input.coadminUsername) || 'Coadmin';
  const originalSessionId = cleanText(input.originalSessionId) || null;
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_IMPERSONATION_TTL_SECONDS;

  if (!staffUid || !staffCoadminUid || !coadminUid) {
    throw new Error('staffUid, staffCoadminUid, and coadminUid are required.');
  }

  return createAppSessionForUser({
    uid: staffUid,
    role: 'staff',
    coadminUid: staffCoadminUid,
    username: staffUsername,
    ttlSeconds,
    deactivatePreviousForUid: false,
    rawContext: {
      source: 'sql_impersonation',
      impersonation: true,
      impersonatedByUid: coadminUid,
      impersonatedByRole: 'coadmin',
      impersonatedByUsername: coadminUsername,
      originalCoadminSessionId: originalSessionId,
    },
  });
}

const APP_SESSION_LOOKUP_SQL = `
  SELECT *
  FROM public.app_sessions
  WHERE session_id = $1
  LIMIT 1
`;

function resolveActiveAppSessionRow(row: Record<string, unknown> | undefined) {
  if (!row) {
    return null;
  }
  const session = mapAppSessionRow(row);
  if (!session.active) {
    return null;
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    return null;
  }
  return session;
}

export async function lookupAppSessionWithClient(sessionId: string, client: PoolClient) {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId) {
    return null;
  }

  try {
    const { rows } = await runMirrorClientQuery<Record<string, unknown>>(
      client,
      APP_SESSION_LOOKUP_SQL,
      [cleanSessionId]
    );
    return resolveActiveAppSessionRow(rows[0]);
  } catch (error) {
    console.error('[APP_SESSIONS] lookup failed', { sessionId: cleanSessionId, error });
    return null;
  }
}

export async function lookupAppSession(sessionId: string) {
  const db = getPlayerMirrorPool();
  const cleanSessionId = cleanText(sessionId);
  if (!db || !cleanSessionId) {
    return null;
  }

  try {
    const result = await db.query(APP_SESSION_LOOKUP_SQL, [cleanSessionId]);
    return resolveActiveAppSessionRow(result.rows[0] as Record<string, unknown> | undefined);
  } catch (error) {
    console.error('[APP_SESSIONS] lookup failed', { sessionId: cleanSessionId, error });
    return null;
  }
}

export async function touchAppSession(sessionId: string) {
  const db = getPlayerMirrorPool();
  const cleanSessionId = cleanText(sessionId);
  if (!db || !cleanSessionId) {
    return false;
  }

  const now = new Date().toISOString();
  try {
    const result = await db.query(
      `
        UPDATE public.app_sessions
        SET last_seen_at = $2::timestamptz, updated_at = $2::timestamptz
        WHERE session_id = $1
          AND active = TRUE
          AND expires_at > $2::timestamptz
      `,
      [cleanSessionId, now]
    );
    return (result.rowCount || 0) > 0;
  } catch (error) {
    console.error('[APP_SESSIONS] touch failed', { sessionId: cleanSessionId, error });
    return false;
  }
}

export async function revokeAppSession(sessionId: string, reason = 'logout') {
  const db = getPlayerMirrorPool();
  const cleanSessionId = cleanText(sessionId);
  if (!db || !cleanSessionId) {
    return false;
  }

  const now = new Date().toISOString();
  const endedReason = cleanText(reason) || 'logout';
  try {
    const result = await db.query(
      `
        UPDATE public.app_sessions
        SET
          active = FALSE,
          ended_at = $2::timestamptz,
          ended_reason = $3,
          revoked_at = $2::timestamptz,
          updated_at = $2::timestamptz
        WHERE session_id = $1
          AND active = TRUE
      `,
      [cleanSessionId, now, endedReason]
    );
    const revoked = (result.rowCount || 0) > 0;
    if (revoked) {
      const { invalidateAppSessionAuthCache } = await import('@/lib/firebase/apiAuth');
      invalidateAppSessionAuthCache(cleanSessionId);
    }
    return revoked;
  } catch (error) {
    console.error('[APP_SESSIONS] revoke failed', { sessionId: cleanSessionId, error });
    return false;
  }
}

export async function revokeActiveSessionsForUid(uid: string, reason = 'revoked') {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) {
    return 0;
  }

  const now = new Date().toISOString();
  const endedReason = cleanText(reason) || 'revoked';
  try {
    const result = await db.query(
      `
        UPDATE public.app_sessions
        SET
          active = FALSE,
          ended_at = $2::timestamptz,
          ended_reason = $3,
          revoked_at = $2::timestamptz,
          updated_at = $2::timestamptz
        WHERE uid = $1
          AND active = TRUE
      `,
      [cleanUid, now, endedReason]
    );
    return result.rowCount || 0;
  } catch (error) {
    console.error('[APP_SESSIONS] revoke active for uid failed', { uid: cleanUid, error });
    return 0;
  }
}
