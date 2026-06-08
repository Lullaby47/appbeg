import 'server-only';

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';

import { invalidatePlayerSessionAuthCache } from '@/lib/server/playerSessionAuthCache';
import type { AppSessionRow } from '@/lib/sql/appSessions';
import {
  acquirePlayerMirrorClient,
  cleanText,
  normalizeJson,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export type PlayerLoginSessionQueryTiming = {
  previous_sessions_select_ms: number;
  previous_sessions_update_ms: number;
  player_session_insert_ms: number;
  players_cache_update_ms: number;
  app_sessions_deactivate_ms: number;
  app_session_insert_ms: number;
  commit_ms: number;
  total_ms: number;
};

export type PlayerLoginSessionSqlTiming = {
  pool_acquire_ms: number;
  start_player_session_sql_ms: number;
  create_app_session_ms: number;
  cache_invalidation_ms: number;
  total_ms: number;
  previous_session_count: number;
  shared_client: boolean;
  query_timing: PlayerLoginSessionQueryTiming;
};

export type CreatePlayerLoginSessionsInSqlInput = {
  playerUid: string;
  deviceId: string;
  role: string;
  coadminUid?: string | null;
  username?: string | null;
  userAgent?: string | null;
  platform?: string | null;
  actorSource?: string;
  playerSessionId?: string;
  appSessionRawContext?: Record<string, unknown>;
};

export type CreatePlayerLoginSessionsInSqlResult = {
  playerSessionId: string;
  appSession: AppSessionRow;
  previousSessionIds: string[];
  timing: PlayerLoginSessionSqlTiming;
};

function sessionTtlSeconds() {
  const fromEnv = Number(process.env.APP_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? Math.trunc(fromEnv)
    : DEFAULT_SESSION_TTL_SECONDS;
}

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

function buildActiveSessionDevice(input: CreatePlayerLoginSessionsInSqlInput) {
  return normalizeJson({
    deviceId: cleanText(input.deviceId),
    userAgent: cleanText(input.userAgent) || null,
    platform: cleanText(input.platform) || null,
  }) as Record<string, unknown>;
}

function invalidateReplacedPlayerSessionCaches(
  playerUid: string,
  previousSessionIds: string[]
) {
  invalidatePlayerSessionAuthCache({ uid: playerUid, reason: 'start' });
  for (const previousSessionId of previousSessionIds) {
    invalidatePlayerSessionAuthCache({
      uid: playerUid,
      playerSessionId: previousSessionId,
      reason: 'replacement',
    });
  }
}

function emptyQueryTiming(): PlayerLoginSessionQueryTiming {
  return {
    previous_sessions_select_ms: 0,
    previous_sessions_update_ms: 0,
    player_session_insert_ms: 0,
    players_cache_update_ms: 0,
    app_sessions_deactivate_ms: 0,
    app_session_insert_ms: 0,
    commit_ms: 0,
    total_ms: 0,
  };
}

async function createPlayerLoginSessionsOnClient(
  client: PoolClient,
  input: CreatePlayerLoginSessionsInSqlInput
): Promise<{
  playerSessionId: string;
  appSession: AppSessionRow;
  previousSessionIds: string[];
  start_player_session_sql_ms: number;
  create_app_session_ms: number;
  query_timing: PlayerLoginSessionQueryTiming;
}> {
  const queryTiming = emptyQueryTiming();
  const transactionStartedAt = Date.now();

  const playerUid = cleanText(input.playerUid);
  const deviceId = cleanText(input.deviceId);
  const role = cleanText(input.role).toLowerCase();
  const coadminUid = cleanText(input.coadminUid) || null;
  const username = cleanText(input.username) || null;
  const playerSessionId = cleanText(input.playerSessionId) || randomUUID();
  const appSessionId = randomUUID();
  const nowIso = new Date().toISOString();
  const now = new Date(nowIso);
  const expiresAt = new Date(Date.now() + sessionTtlSeconds() * 1000);
  const source = cleanText(input.actorSource) || 'sql_player_login';
  const activeSessionDevice = buildActiveSessionDevice(input);
  const rawSessionData = normalizeJson({
    playerUid,
    deviceId,
    startedAt: nowIso,
    lastSeenAt: nowIso,
    active: true,
  }) as Record<string, unknown>;

  const rawProfilePatch = normalizeJson({
    activeSessionId: playerSessionId,
    activeDeviceId: deviceId,
    activeSessionDevice,
    activeSessionStartedAt: nowIso,
    activeSessionLastSeenAt: nowIso,
    activeSessionUpdatedAt: nowIso,
    lastLoginAt: nowIso,
  }) as Record<string, unknown>;

  const playerSessionStartedAt = Date.now();

  const previousSessionsStartedAt = Date.now();
  const previousResult = await client.query<{ session_id: string }>(
    `
      UPDATE public.player_sessions_cache
      SET
        active = FALSE,
        status = 'ended',
        ended_at = $2::timestamptz,
        ended_reason = 'replaced_by_new_login',
        updated_at = $2::timestamptz,
        mirrored_at = $2::timestamptz
      WHERE player_uid = $1
        AND deleted_at IS NULL
        AND active = TRUE
      RETURNING session_id
    `,
    [playerUid, nowIso]
  );
  queryTiming.previous_sessions_select_ms = 0;
  queryTiming.previous_sessions_update_ms = Date.now() - previousSessionsStartedAt;

  const previousSessionIds = previousResult.rows
    .map((row) => cleanText(row.session_id))
    .filter(Boolean);

  const playerWriteStartedAt = Date.now();
  await client.query(
    `
      WITH new_session AS (
        INSERT INTO public.player_sessions_cache (
          session_id,
          player_uid,
          coadmin_uid,
          device_id,
          active,
          status,
          started_at,
          last_seen_at,
          ended_at,
          ended_reason,
          expires_at,
          created_at,
          updated_at,
          raw_firestore_data,
          source,
          mirrored_at,
          deleted_at
        )
        VALUES (
          $1,
          $2,
          COALESCE(
            NULLIF($3::text, ''),
            (
              SELECT COALESCE(
                NULLIF(BTRIM(coadmin_uid::text), ''),
                NULLIF(BTRIM(created_by::text), '')
              )
              FROM public.players_cache
              WHERE uid = $2
                AND deleted_at IS NULL
              LIMIT 1
            )
          ),
          NULLIF($4::text, ''),
          TRUE,
          'active',
          $5::timestamptz,
          $5::timestamptz,
          NULL,
          NULL,
          NULL,
          $5::timestamptz,
          $5::timestamptz,
          $6::jsonb,
          $7,
          $5::timestamptz,
          NULL
        )
        RETURNING session_id, player_uid
      )
      UPDATE public.players_cache AS pc
      SET
        active_session_id = ns.session_id,
        active_device_id = $4,
        active_session_last_seen_at = $5::timestamptz,
        updated_at = $5::timestamptz,
        raw_firestore_data = COALESCE(pc.raw_firestore_data, '{}'::jsonb) || $8::jsonb,
        mirrored_at = $5::timestamptz
      FROM new_session AS ns
      WHERE pc.uid = ns.player_uid
        AND pc.deleted_at IS NULL
    `,
    [
      playerSessionId,
      playerUid,
      coadminUid,
      deviceId,
      nowIso,
      JSON.stringify(rawSessionData),
      source,
      JSON.stringify(rawProfilePatch),
    ]
  );
  const playerWriteMs = Date.now() - playerWriteStartedAt;
  queryTiming.player_session_insert_ms = playerWriteMs;
  queryTiming.players_cache_update_ms = 0;

  const startPlayerSessionSqlMs = Date.now() - playerSessionStartedAt;
  const createAppSessionStartedAt = Date.now();
  const rawContext = {
    ...(normalizeJson(input.appSessionRawContext || {}) as Record<string, unknown>),
    playerSessionId,
  };

  const appSessionStartedAt = Date.now();
  const insertResult = await client.query(
    `
      WITH deactivated AS (
        UPDATE public.app_sessions
        SET
          active = FALSE,
          ended_at = $2::timestamptz,
          ended_reason = $3,
          revoked_at = $2::timestamptz,
          updated_at = $2::timestamptz
        WHERE uid = $1
          AND active = TRUE
      )
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
        $4,
        $1,
        $5,
        COALESCE(
          NULLIF($6::text, ''),
          (
            SELECT COALESCE(
              NULLIF(BTRIM(coadmin_uid::text), ''),
              NULLIF(BTRIM(created_by::text), '')
            )
            FROM public.players_cache
            WHERE uid = $1
              AND deleted_at IS NULL
            LIMIT 1
          )
        ),
        NULLIF($7::text, ''),
        NULLIF($8::text, ''),
        TRUE,
        $9::timestamptz,
        $10::timestamptz,
        NULL,
        NULL,
        $10::timestamptz,
        $10::timestamptz,
        NULL,
        $11::jsonb
      )
      RETURNING *
    `,
    [
      playerUid,
      now.toISOString(),
      'replaced_by_new_login',
      appSessionId,
      role,
      coadminUid,
      username,
      deviceId,
      expiresAt.toISOString(),
      now.toISOString(),
      JSON.stringify(rawContext),
    ]
  );
  const appSessionBatchMs = Date.now() - appSessionStartedAt;
  queryTiming.app_sessions_deactivate_ms = 0;
  queryTiming.app_session_insert_ms = appSessionBatchMs;

  const createAppSessionMs = Date.now() - createAppSessionStartedAt;
  queryTiming.total_ms = Date.now() - transactionStartedAt;

  return {
    playerSessionId,
    appSession: mapAppSessionRow(insertResult.rows[0] as Record<string, unknown>),
    previousSessionIds,
    start_player_session_sql_ms: startPlayerSessionSqlMs,
    create_app_session_ms: createAppSessionMs,
    query_timing: queryTiming,
  };
}

export async function createPlayerLoginSessionsInSql(
  input: CreatePlayerLoginSessionsInSqlInput
): Promise<CreatePlayerLoginSessionsInSqlResult> {
  const totalStartedAt = Date.now();
  const playerUid = cleanText(input.playerUid);
  const deviceId = cleanText(input.deviceId);
  if (!playerUid || !deviceId) {
    throw new Error('Postgres unavailable or missing playerUid/deviceId.');
  }

  const acquired = await acquirePlayerMirrorClient({
    context: 'sql_player_login_sessions',
    route: '/api/auth/login-sql',
  });
  if (!acquired) {
    throw new Error('Postgres unavailable or missing playerUid/deviceId.');
  }
  const { client } = acquired;
  const poolAcquireMs = acquired.timing.pool_acquire_ms;

  try {
    await client.query('BEGIN');
    const created = await createPlayerLoginSessionsOnClient(client, input);

    const commitStartedAt = Date.now();
    await client.query('COMMIT');
    created.query_timing.commit_ms = Date.now() - commitStartedAt;
    created.query_timing.total_ms = Date.now() - totalStartedAt;

    const cacheInvalidationStartedAt = Date.now();
    invalidateReplacedPlayerSessionCaches(playerUid, created.previousSessionIds);
    const cacheInvalidationMs = Date.now() - cacheInvalidationStartedAt;

    const timing: PlayerLoginSessionSqlTiming = {
      pool_acquire_ms: poolAcquireMs,
      start_player_session_sql_ms: created.start_player_session_sql_ms,
      create_app_session_ms: created.create_app_session_ms,
      cache_invalidation_ms: cacheInvalidationMs,
      total_ms: Date.now() - totalStartedAt,
      previous_session_count: created.previousSessionIds.length,
      shared_client: true,
      query_timing: created.query_timing,
    };

    return {
      playerSessionId: created.playerSessionId,
      appSession: created.appSession,
      previousSessionIds: created.previousSessionIds,
      timing,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
