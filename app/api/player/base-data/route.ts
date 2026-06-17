import { NextResponse } from 'next/server';

import { requirePlayerApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import { logPlayerApiAuthOk } from '@/lib/server/playerApiAuthLog';
import {
  emptyPlayerBaseDataPayloadExport,
  loadPlayerBaseData,
} from '@/lib/server/playerBaseDataRead';
import { extractPgErrorDetails } from '@/lib/server/sqlErrorDetails';
import { logRouteSessionValidation, sessionIdsFromRequest } from '@/lib/server/sessionAuthLog';
import { recordRouteMetric } from '@/lib/server/logMetrics';
import { API_ROUTE_SLOW_MS, isPlayerVerboseLogs } from '@/lib/server/verboseLogs';

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/player/base-data';

function safeEmptyPayload() {
  return emptyPlayerBaseDataPayloadExport(new Date().toISOString());
}

function largestTimingStage(stages: Record<string, number>) {
  return Object.entries(stages).reduce(
    (largest, [stage, ms]) => (ms > largest.ms ? { stage, ms } : largest),
    { stage: 'none', ms: 0 }
  );
}

function authSqlSessionMs(timing: unknown) {
  const value = (timing as { sql_session_ms?: unknown }).sql_session_ms;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function logPlayerBaseDataSuccess(details: {
  timingLog: Record<string, unknown>;
  summaryLog: Record<string, unknown>;
  totalMs: number;
}) {
  recordRouteMetric({
    route: ROUTE,
    durationMs: details.totalMs,
    ok: true,
    slowThresholdMs: API_ROUTE_SLOW_MS,
  });
  if (!isPlayerVerboseLogs() && details.totalMs < API_ROUTE_SLOW_MS) {
    return;
  }
  console.info('[PLAYER_BASE_DATA_TIMING]', details.timingLog);
  console.info('[PLAYER_BASE_DATA]', details.summaryLog);
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const headerSessions = sessionIdsFromRequest(request);

  try {
    const auth = await requirePlayerApiUser(request);
    if ('response' in auth) {
      logRouteSessionValidation(ROUTE, {
        ok: false,
        ...headerSessions,
        canonical_session_id: headerSessions.player_session_id,
        validates: 'player_session_sql',
        auth_path: auth.timing.auth_path,
        session_source: auth.timing.session_source,
      });
      return auth.response;
    }

    logRouteSessionValidation(ROUTE, {
      ok: true,
      ...headerSessions,
      canonical_session_id: headerSessions.player_session_id,
      validates: 'player_session_sql',
      auth_path: auth.authPath,
      session_source: auth.timing.session_source,
      uid: auth.user.uid,
    });
    logPlayerApiAuthOk(request, {
      route: ROUTE,
      uid: auth.user.uid,
      role: auth.user.role,
      authPath: auth.authPath,
    });

    const authMs = Date.now() - startedAt;
    const coadminUid = scopedCoadminUid(auth.user);
    const playerUid = auth.user.uid;

    if (!coadminUid) {
      const serializationStartedAt = Date.now();
      const response = NextResponse.json(safeEmptyPayload());
      const timing = {
        auth_ms: authMs,
        player_profile_lookup_ms: auth.timing.sql_profile_ms ?? 0,
        player_session_ms: authSqlSessionMs(auth.timing) ?? 0,
        shared_client: false,
        parallel: true,
        client_acquire_ms: 0,
        staff_ms: 0,
        game_logins_ms: 0,
        freeplay_ms: 0,
        referral_rewards_ms: 0,
        total_sql_ms: 0,
        pool_waiting_max: 0,
        total_ms: Date.now() - startedAt,
      };
      const serializationMs = Date.now() - serializationStartedAt;
      logPlayerBaseDataSuccess({
        totalMs: timing.total_ms,
        timingLog: {
        auth_session_validation_ms: timing.auth_ms,
        player_profile_lookup_ms: timing.player_profile_lookup_ms,
        player_session_ms: timing.player_session_ms,
        staff_coadmin_lookup_ms: timing.staff_ms,
        game_logins_ms: timing.game_logins_ms,
        freeplay_pending_ms: timing.freeplay_ms,
        referral_rewards_ms: timing.referral_rewards_ms,
        serialization_ms: serializationMs,
        total_sql_ms: timing.total_sql_ms,
        total_ms: timing.total_ms,
        dominant_stage: largestTimingStage({
          auth_session_validation_ms: timing.auth_ms,
          staff_coadmin_lookup_ms: timing.staff_ms,
          game_logins_ms: timing.game_logins_ms,
          freeplay_pending_ms: timing.freeplay_ms,
          referral_rewards_ms: timing.referral_rewards_ms,
          serialization_ms: serializationMs,
        }),
        counts: { staff: 0, gameLogins: 0, referralGroups: 0 },
        source: 'postgres',
        },
        summaryLog: {
        ...timing,
        counts: { staff: 0, gameLogins: 0, referralGroups: 0 },
        pendingGift: false,
        source: 'postgres',
        },
      });
      return response;
    }

    const { payload, timing } = await loadPlayerBaseData({
      playerUid,
      coadminUid,
      authMs,
      authPath: auth.authPath,
      role: auth.user.role,
    });

    const serializationStartedAt = Date.now();
    const response = NextResponse.json(payload);
    const serializationMs = Date.now() - serializationStartedAt;
    const timingStages = {
      auth_session_validation_ms: timing.auth_ms,
      staff_coadmin_lookup_ms: timing.staff_ms,
      game_logins_ms: timing.game_logins_ms,
      freeplay_pending_ms: timing.freeplay_ms,
      referral_rewards_ms: timing.referral_rewards_ms,
      serialization_ms: serializationMs,
    };
    const routeTotalMs = Date.now() - startedAt;
    logPlayerBaseDataSuccess({
      totalMs: routeTotalMs,
      timingLog: {
      auth_session_validation_ms: timing.auth_ms,
      player_profile_lookup_ms: auth.timing.sql_profile_ms ?? null,
      player_session_ms: authSqlSessionMs(auth.timing),
      staff_coadmin_lookup_ms: timing.staff_ms,
      game_logins_ms: timing.game_logins_ms,
      freeplay_pending_ms: timing.freeplay_ms,
      referral_rewards_ms: timing.referral_rewards_ms,
      serialization_ms: serializationMs,
      total_sql_ms: timing.total_sql_ms,
      total_ms: Date.now() - startedAt,
      parallel: timing.parallel,
      shared_client: timing.shared_client,
      client_acquire_ms: timing.client_acquire_ms,
      pool_waiting_max: timing.pool_waiting_max,
      dominant_stage: largestTimingStage(timingStages),
      counts: {
        staff: payload.staff.length,
        gameLogins: payload.gameLogins.length,
        referralGroups: payload.referralRewards.groups.length,
      },
      source: payload.source,
      },
      summaryLog: {
      auth_ms: timing.auth_ms,
      shared_client: timing.shared_client,
      parallel: timing.parallel,
      client_acquire_ms: timing.client_acquire_ms,
      staff_ms: timing.staff_ms,
      game_logins_ms: timing.game_logins_ms,
      freeplay_ms: timing.freeplay_ms,
      referral_rewards_ms: timing.referral_rewards_ms,
      total_sql_ms: timing.total_sql_ms,
      pool_waiting_max: timing.pool_waiting_max,
      total_ms: timing.total_ms,
      counts: {
        staff: payload.staff.length,
        gameLogins: payload.gameLogins.length,
        referralGroups: payload.referralRewards.groups.length,
      },
      pendingGift: payload.pendingGift.hasPendingGift,
      source: payload.source,
      },
    });

    return response;
  } catch (error) {
    const pg = extractPgErrorDetails(error);
    console.error('[PLAYER_BASE_DATA_ERROR]', {
      uid: null,
      role: 'player',
      authPath: null,
      stage: 'route',
      sqlQuery: null,
      durationMs: Date.now() - startedAt,
      ...pg,
    });
    return NextResponse.json(safeEmptyPayload());
  }
}
