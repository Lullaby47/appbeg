import 'server-only';

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { isPlayerSessionSqlReadEnabled } from '@/lib/server/authSqlRead';
import {
  acquirePlayerMirrorClient,
  cleanText,
  getPlayerMirrorPool,
  getPlayerMirrorPoolStats,
  isPgConnectionTimeoutError,
  normalizeJson,
  runMirrorClientQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

/** Minimum interval between successful app_sessions last_seen updates. */
const APP_SESSION_TOUCH_THROTTLE_MS = 5 * 60_000;
/** Shorter backoff after a failed touch so we do not hammer Postgres every request. */
const APP_SESSION_TOUCH_FAILURE_BACKOFF_MS = 2 * 60_000;
const APP_SESSION_TOUCH_FAILURE_LOG_THROTTLE_MS = 5 * 60_000;

const APP_SESSION_TOUCH_SQL = `
  UPDATE public.app_sessions
  SET last_seen_at = $2::timestamptz, updated_at = $2::timestamptz
  WHERE session_id = $1
    AND active = TRUE
    AND expires_at > $2::timestamptz
`;

const globalAppSessionTouch = globalThis as typeof globalThis & {
  __appbegAppSessionTouchState?: {
    lastTouchAt: Map<string, number>;
    inflight: Set<string>;
    lastFailureLogAt: Map<string, number>;
    lastSkipLogAt: Map<string, number>;
  };
};

function appSessionTouchState() {
  if (!globalAppSessionTouch.__appbegAppSessionTouchState) {
    globalAppSessionTouch.__appbegAppSessionTouchState = {
      lastTouchAt: new Map(),
      inflight: new Set(),
      lastFailureLogAt: new Map(),
      lastSkipLogAt: new Map(),
    };
  }
  return globalAppSessionTouch.__appbegAppSessionTouchState;
}

function shouldSkipAppSessionTouchForRole(role: string) {
  return cleanText(role).toLowerCase() === 'player' && isPlayerSessionSqlReadEnabled();
}

function logAppSessionTouchSkipped(sessionId: string) {
  const state = appSessionTouchState();
  const now = Date.now();
  const lastLog = state.lastSkipLogAt.get(sessionId) || 0;
  if (now - lastLog < APP_SESSION_TOUCH_FAILURE_LOG_THROTTLE_MS) {
    return;
  }
  state.lastSkipLogAt.set(sessionId, now);
  console.info('[APP_SESSIONS]', {
    app_session_touch_skipped: true,
    reason: 'player_sql_session_authoritative',
    sessionIdPrefix: sessionId.slice(0, 8),
  });
}

function shouldRetryAppSessionTouch(error: unknown) {
  if (isPgConnectionTimeoutError(error)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error || '');
  const lower = message.toLowerCase();
  return (
    lower.includes('connection terminated') ||
    lower.includes('too many clients') ||
    lower.includes('remaining connection slots')
  );
}

function logAppSessionTouchFailure(sessionId: string, error: unknown, retried: boolean) {
  const state = appSessionTouchState();
  const now = Date.now();
  const lastLog = state.lastFailureLogAt.get(sessionId) || 0;
  if (now - lastLog < APP_SESSION_TOUCH_FAILURE_LOG_THROTTLE_MS) {
    return;
  }
  state.lastFailureLogAt.set(sessionId, now);
  const poolStats = getPlayerMirrorPoolStats();
  console.info('[APP_SESSIONS] touch failed (non-fatal)', {
    sessionIdPrefix: sessionId.slice(0, 8),
    retried,
    error: error instanceof Error ? error.message : String(error),
    pool_totalCount: poolStats?.totalCount ?? null,
    pool_idleCount: poolStats?.idleCount ?? null,
    pool_waitingCount: poolStats?.waitingCount ?? null,
    pool_max: poolStats?.max ?? null,
  });
}

/**
 * Fire-and-forget last_seen update. Non-fatal: auth must not depend on this succeeding.
 * Debounced globally (per warm serverless instance) to avoid pool contention.
 */
export function scheduleAppSessionTouchIfDue(
  sessionId: string,
  options?: { role?: string }
) {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId || !getPlayerMirrorPool()) {
    return;
  }

  if (shouldSkipAppSessionTouchForRole(options?.role || '')) {
    logAppSessionTouchSkipped(cleanSessionId);
    return;
  }

  const state = appSessionTouchState();
  const now = Date.now();
  const lastTouch = state.lastTouchAt.get(cleanSessionId) || 0;
  if (now - lastTouch < APP_SESSION_TOUCH_THROTTLE_MS) {
    return;
  }
  if (state.inflight.has(cleanSessionId)) {
    return;
  }

  state.lastTouchAt.set(cleanSessionId, now);
  state.inflight.add(cleanSessionId);

  queueMicrotask(() => {
    void touchAppSession(cleanSessionId)
      .then((ok) => {
        if (!ok) {
          state.lastTouchAt.set(
            cleanSessionId,
            Date.now() - APP_SESSION_TOUCH_THROTTLE_MS + APP_SESSION_TOUCH_FAILURE_BACKOFF_MS
          );
        }
      })
      .finally(() => {
        state.inflight.delete(cleanSessionId);
      });
  });
}

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

async function touchAppSessionOnce(sessionId: string, nowIso: string) {
  const acquired = await acquirePlayerMirrorClient({ context: 'app_session_touch' });
  if (!acquired) {
    return false;
  }
  try {
    const result = await acquired.client.query(APP_SESSION_TOUCH_SQL, [sessionId, nowIso]);
    return (result.rowCount || 0) > 0;
  } finally {
    acquired.client.release();
  }
}

export async function touchAppSession(sessionId: string) {
  const cleanSessionId = cleanText(sessionId);
  if (!cleanSessionId || !getPlayerMirrorPool()) {
    return false;
  }

  const nowIso = new Date().toISOString();
  try {
    return await touchAppSessionOnce(cleanSessionId, nowIso);
  } catch (error) {
    if (!shouldRetryAppSessionTouch(error)) {
      logAppSessionTouchFailure(cleanSessionId, error, false);
      return false;
    }
    try {
      return await touchAppSessionOnce(cleanSessionId, nowIso);
    } catch (retryError) {
      logAppSessionTouchFailure(cleanSessionId, retryError, true);
      return false;
    }
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
