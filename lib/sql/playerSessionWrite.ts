import 'server-only';

import { randomUUID } from 'crypto';

import {
  acquirePlayerMirrorClient,
  cleanText,
  getPlayerMirrorPool,
  logPlayerMirrorPoolStats,
  normalizeJson,
  runMirrorClientQuery,
} from '@/lib/sql/playerMirrorCommon';

type PlayerSessionTouchSqlTiming = {
  pool_acquire_ms: number;
  query_exec_ms: number;
  cache_invalidation_ms: number;
  total_ms: number;
  combined: boolean;
  combined_update_query_exec_ms: number;
  session_update_pool_acquire_ms: number;
  session_update_query_exec_ms: number;
  players_update_pool_acquire_ms: number;
  players_update_query_exec_ms: number;
};

const touchInFlightBySession = new Map<string, number>();
let touchInFlightGlobal = 0;

function touchDiagnosticKey(playerUid: string, sessionId: string) {
  return `${playerUid}:${sessionId}`;
}

function beginTouchDiagnostic(playerUid: string, sessionId: string) {
  touchInFlightGlobal += 1;
  const key = touchDiagnosticKey(playerUid, sessionId);
  const sessionInFlight = (touchInFlightBySession.get(key) || 0) + 1;
  touchInFlightBySession.set(key, sessionInFlight);
  return {
    concurrent_global: touchInFlightGlobal,
    concurrent_session: sessionInFlight,
  };
}

function endTouchDiagnostic(playerUid: string, sessionId: string) {
  touchInFlightGlobal = Math.max(0, touchInFlightGlobal - 1);
  const key = touchDiagnosticKey(playerUid, sessionId);
  const sessionInFlight = (touchInFlightBySession.get(key) || 1) - 1;
  if (sessionInFlight <= 0) {
    touchInFlightBySession.delete(key);
  } else {
    touchInFlightBySession.set(key, sessionInFlight);
  }
}

function readPlayerMirrorPoolCounts() {
  const pool = getPlayerMirrorPool();
  if (!pool) {
    return {
      pool_total_count: null,
      pool_idle_count: null,
      pool_waiting_count: null,
    };
  }
  return {
    pool_total_count: pool.totalCount,
    pool_idle_count: pool.idleCount,
    pool_waiting_count: pool.waitingCount,
  };
}

function logPlayerSessionTouchSql(
  input: {
    playerUid: string;
    sessionId: string;
    deviceId: string | null;
    sql_ok: boolean;
    reason?: string;
    error?: string;
  } & PlayerSessionTouchSqlTiming & {
      concurrent_global: number;
      concurrent_session: number;
      pool_total_count: number | null;
      pool_idle_count: number | null;
      pool_waiting_count: number | null;
      cache_invalidation_applied: boolean;
      shared_client: boolean;
    }
) {
  console.info('[PLAYER_SESSION_TOUCH_SQL]', input);
  if (input.total_ms >= 500 || (input.pool_waiting_count ?? 0) > 0) {
    logPlayerMirrorPoolStats('player_session_touch_slow');
  }
}

export type StartPlayerSessionInSqlInput = {
  playerUid: string;
  deviceId: string;
  userAgent?: string | null;
  platform?: string | null;
  actorSource?: string;
};

export type StartPlayerSessionInSqlResult = {
  sessionId: string;
  previousSessionIds: string[];
  deviceId: string;
};

export type TouchPlayerSessionInSqlInput = {
  playerUid: string;
  sessionId: string;
  deviceId?: string | null;
};

export type TouchPlayerSessionInSqlResult = {
  ok: boolean;
  reason?: string;
};

export type EndPlayerSessionInSqlInput = {
  playerUid: string;
  sessionId: string;
  reason?: string;
};

export type EndPlayerSessionInSqlResult = {
  ok: boolean;
  reason?: string;
};

function buildActiveSessionDevice(input: StartPlayerSessionInSqlInput) {
  return normalizeJson({
    deviceId: cleanText(input.deviceId),
    userAgent: cleanText(input.userAgent) || null,
    platform: cleanText(input.platform) || null,
  }) as Record<string, unknown>;
}

export async function startPlayerSessionInSql(
  input: StartPlayerSessionInSqlInput
): Promise<StartPlayerSessionInSqlResult> {
  const db = getPlayerMirrorPool();
  const playerUid = cleanText(input.playerUid);
  const deviceId = cleanText(input.deviceId);
  if (!db || !playerUid || !deviceId) {
    throw new Error('Postgres unavailable or missing playerUid/deviceId.');
  }

  const sessionId = randomUUID();
  const nowIso = new Date().toISOString();
  const source = cleanText(input.actorSource) || 'sql_player_session_start';
  const activeSessionDevice = buildActiveSessionDevice(input);

  const rawSessionData = normalizeJson({
    playerUid,
    deviceId,
    startedAt: nowIso,
    lastSeenAt: nowIso,
    active: true,
  }) as Record<string, unknown>;

  const rawProfilePatch = normalizeJson({
    activeSessionId: sessionId,
    activeDeviceId: deviceId,
    activeSessionDevice,
    activeSessionStartedAt: nowIso,
    activeSessionLastSeenAt: nowIso,
    activeSessionUpdatedAt: nowIso,
    lastLoginAt: nowIso,
  }) as Record<string, unknown>;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const previousResult = await client.query<{ session_id: string }>(
      `
        SELECT session_id
        FROM public.player_sessions_cache
        WHERE player_uid = $1
          AND deleted_at IS NULL
          AND active = TRUE
      `,
      [playerUid]
    );
    const previousSessionIds = previousResult.rows
      .map((row) => cleanText(row.session_id))
      .filter(Boolean);

    await client.query(
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
      `,
      [playerUid, nowIso]
    );

    const playerRow = await client.query<{ coadmin_uid: unknown; created_by: unknown }>(
      `
        SELECT coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [playerUid]
    );
    const coadminUid =
      cleanText(playerRow.rows[0]?.coadmin_uid) ||
      cleanText(playerRow.rows[0]?.created_by) ||
      null;

    await client.query(
      `
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
          $1, $2, NULLIF($3, ''), NULLIF($4, ''), TRUE, 'active',
          $5::timestamptz, $5::timestamptz, NULL, NULL, NULL,
          $5::timestamptz, $5::timestamptz, $6::jsonb, $7, $5::timestamptz, NULL
        )
      `,
      [
        sessionId,
        playerUid,
        coadminUid,
        deviceId,
        nowIso,
        JSON.stringify(rawSessionData),
        source,
      ]
    );

    await client.query(
      `
        UPDATE public.players_cache
        SET
          active_session_id = $2,
          active_device_id = $3,
          active_session_last_seen_at = $4::timestamptz,
          updated_at = $4::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $5::jsonb,
          mirrored_at = $4::timestamptz
        WHERE uid = $1
          AND deleted_at IS NULL
      `,
      [playerUid, sessionId, deviceId, nowIso, JSON.stringify(rawProfilePatch)]
    );

    await client.query('COMMIT');
    return { sessionId, previousSessionIds, deviceId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function touchPlayerSessionInSql(
  input: TouchPlayerSessionInSqlInput
): Promise<TouchPlayerSessionInSqlResult> {
  const startedAt = Date.now();
  const db = getPlayerMirrorPool();
  const playerUid = cleanText(input.playerUid);
  const sessionId = cleanText(input.sessionId);
  const deviceId = cleanText(input.deviceId);
  const timing: PlayerSessionTouchSqlTiming = {
    pool_acquire_ms: 0,
    query_exec_ms: 0,
    cache_invalidation_ms: 0,
    total_ms: 0,
    combined: true,
    combined_update_query_exec_ms: 0,
    session_update_pool_acquire_ms: 0,
    session_update_query_exec_ms: 0,
    players_update_pool_acquire_ms: 0,
    players_update_query_exec_ms: 0,
  };
  const overlap = playerUid && sessionId ? beginTouchDiagnostic(playerUid, sessionId) : {
    concurrent_global: touchInFlightGlobal,
    concurrent_session: 0,
  };

  let sharedClient = false;

  const finishLog = (payload: {
    sql_ok: boolean;
    reason?: string;
    error?: string;
  }) => {
    timing.total_ms = Date.now() - startedAt;
    logPlayerSessionTouchSql({
      playerUid,
      sessionId,
      deviceId: deviceId || null,
      ...timing,
      ...overlap,
      ...readPlayerMirrorPoolCounts(),
      cache_invalidation_applied: false,
      shared_client: sharedClient,
      ...payload,
    });
  };

  if (!db || !playerUid || !sessionId) {
    finishLog({ sql_ok: false, reason: 'postgres_unavailable' });
    return { ok: false, reason: 'postgres_unavailable' };
  }

  const nowIso = new Date().toISOString();
  const acquired = await acquirePlayerMirrorClient({
    context: 'player_session_touch',
  });
  if (!acquired) {
    finishLog({ sql_ok: false, reason: 'postgres_unavailable' });
    return { ok: false, reason: 'postgres_unavailable' };
  }

  timing.pool_acquire_ms = acquired.timing.pool_acquire_ms;
  sharedClient = true;
  const { client } = acquired;

  try {
    const touchResult = await runMirrorClientQuery<{
      touched_count: number;
      player_touch_count: number;
    }>(
      client,
      `
        WITH touched AS (
          UPDATE public.player_sessions_cache
          SET
            last_seen_at = $3::timestamptz,
            updated_at = $3::timestamptz,
            mirrored_at = $3::timestamptz,
            device_id = COALESCE(NULLIF($4::text, ''), device_id),
            raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
              'lastSeenAt', $3::text,
              'active', TRUE
            )
          WHERE session_id = $1::text
            AND player_uid = $2::text
            AND deleted_at IS NULL
            AND active = TRUE
            AND ended_at IS NULL
          RETURNING session_id, player_uid
        ),
        player_touch AS (
          UPDATE public.players_cache AS p
          SET
            active_session_last_seen_at = $3::timestamptz,
            updated_at = $3::timestamptz,
            mirrored_at = $3::timestamptz,
            raw_firestore_data = COALESCE(p.raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
              'activeSessionLastSeenAt', $3::text,
              'activeSessionUpdatedAt', $3::text
            )
          FROM touched AS t
          WHERE p.uid = t.player_uid
            AND p.deleted_at IS NULL
            AND p.active_session_id = t.session_id
          RETURNING p.uid
        )
        SELECT
          (SELECT count(*)::int FROM touched) AS touched_count,
          (SELECT count(*)::int FROM player_touch) AS player_touch_count
      `,
      [sessionId, playerUid, nowIso, deviceId]
    );

    timing.combined = true;
    timing.combined_update_query_exec_ms = touchResult.timing.query_exec_ms;
    timing.session_update_pool_acquire_ms = 0;
    timing.session_update_query_exec_ms = 0;
    timing.players_update_pool_acquire_ms = 0;
    timing.players_update_query_exec_ms = 0;
    timing.query_exec_ms = touchResult.timing.query_exec_ms;

    const touchedCount = Number(touchResult.rows[0]?.touched_count || 0);
    if (touchedCount === 0) {
      finishLog({ sql_ok: false, reason: 'session_inactive_or_missing' });
      return { ok: false, reason: 'session_inactive_or_missing' };
    }

    finishLog({ sql_ok: true });
    return { ok: true };
  } catch (error) {
    finishLog({
      sql_ok: false,
      reason: 'touch_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'touch_failed' };
  } finally {
    client.release();
    if (playerUid && sessionId) {
      endTouchDiagnostic(playerUid, sessionId);
    }
  }
}

export async function endPlayerSessionInSql(
  input: EndPlayerSessionInSqlInput
): Promise<EndPlayerSessionInSqlResult> {
  const startedAt = Date.now();
  const db = getPlayerMirrorPool();
  const playerUid = cleanText(input.playerUid);
  const sessionId = cleanText(input.sessionId);
  const endedReason = cleanText(input.reason) || 'logout';
  if (!db || !playerUid || !sessionId) {
    console.info('[PLAYER_SESSION_END_SQL]', {
      playerUid,
      sessionId,
      endedReason,
      sql_ok: false,
      durationMs: Date.now() - startedAt,
      reason: 'postgres_unavailable',
    });
    return { ok: false, reason: 'postgres_unavailable' };
  }

  const nowIso = new Date().toISOString();

  try {
    const sessionResult = await db.query(
      `
        UPDATE public.player_sessions_cache
        SET
          active = FALSE,
          status = 'ended',
          ended_at = $4::timestamptz,
          ended_reason = $3::text,
          updated_at = $4::timestamptz,
          mirrored_at = $4::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'active', FALSE,
            'endedAt', $4::text,
            'endedReason', $3::text
          )
        WHERE session_id = $1::text
          AND player_uid = $2::text
          AND deleted_at IS NULL
        RETURNING session_id
      `,
      [sessionId, playerUid, endedReason, nowIso]
    );

    if ((sessionResult.rowCount || 0) === 0) {
      console.info('[PLAYER_SESSION_END_SQL]', {
        playerUid,
        sessionId,
        endedReason,
        sql_ok: false,
        durationMs: Date.now() - startedAt,
        reason: 'session_missing',
      });
      return { ok: false, reason: 'session_missing' };
    }

    await db.query(
      `
        UPDATE public.players_cache
        SET
          active_session_id = NULL,
          active_device_id = NULL,
          updated_at = $3::timestamptz,
          mirrored_at = $3::timestamptz,
          raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || jsonb_build_object(
            'activeSessionId', NULL,
            'activeDeviceId', NULL
          )
        WHERE uid = $1::text
          AND deleted_at IS NULL
          AND active_session_id = $2::text
      `,
      [playerUid, sessionId, nowIso]
    );

    console.info('[PLAYER_SESSION_END_SQL]', {
      playerUid,
      sessionId,
      endedReason,
      sql_ok: true,
      durationMs: Date.now() - startedAt,
    });
    return { ok: true };
  } catch (error) {
    console.warn('[PLAYER_SESSION_END_SQL]', {
      playerUid,
      sessionId,
      endedReason,
      sql_ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'end_failed' };
  }
}
