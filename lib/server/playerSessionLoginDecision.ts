import 'server-only';

import { isSqlPlayerLoginEnabled } from '@/lib/server/sqlPlayerLogin';
import { getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { lookupApiUserProfileFromSqlCache } from '@/lib/sql/playersCache';

export type PlayerSessionLoginDecision =
  | 'inline_sql_sessions'
  | 'bootstrap_expected';

export type PlayerSessionReadyCheck = {
  uid: string;
  role: string;
  existingPlayerSessionId: string | null;
  activeSessionCount: number | null;
  appSessionExists: boolean;
  playerSessionExists: boolean;
  decision: PlayerSessionLoginDecision;
  reason: string;
};

async function countActivePlayerSessions(playerUid: string) {
  const pool = getPlayerMirrorPool();
  if (!pool) {
    return null;
  }

  try {
    const result = await pool.query<{ c: string }>(
      `
        SELECT COUNT(*)::int AS c
        FROM public.player_sessions_cache
        WHERE player_uid = $1
          AND deleted_at IS NULL
          AND active = TRUE
      `,
      [playerUid]
    );
    return Number(result.rows[0]?.c ?? 0);
  } catch {
    return null;
  }
}

export async function evaluatePlayerSessionLoginDecision(input: {
  uid: string;
  role: string;
  deviceId?: string | null;
  appSessionExists?: boolean;
}) {
  const uid = String(input.uid || '').trim();
  const role = String(input.role || '').trim().toLowerCase();
  const inlineSqlPlayerSessions = role === 'player' && isSqlPlayerLoginEnabled();

  const profileLookup = uid ? await lookupApiUserProfileFromSqlCache(uid) : null;
  const existingPlayerSessionId =
    String(profileLookup?.profile?.activeSessionId || '').trim() || null;
  const activeSessionCount = uid ? await countActivePlayerSessions(uid) : null;
  const playerSessionExists = Boolean(existingPlayerSessionId) || (activeSessionCount ?? 0) > 0;

  let decision: PlayerSessionLoginDecision = 'inline_sql_sessions';
  let reason = 'inline_sql_player_sessions';

  if (role === 'player' && !inlineSqlPlayerSessions) {
    decision = 'bootstrap_expected';
    reason = 'sql_player_login_disabled_bootstrap_will_create_session';
  }

  const readyCheck: PlayerSessionReadyCheck = {
    uid,
    role,
    existingPlayerSessionId,
    activeSessionCount,
    appSessionExists: Boolean(input.appSessionExists),
    playerSessionExists,
    decision,
    reason,
  };

  console.info('[PLAYER_SESSION_READY_CHECK]', readyCheck);

  return readyCheck;
}

export function logLoginSqlDecision(values: {
  uid: string;
  role: string;
  authenticated: boolean;
  playerSessionRequired: boolean;
  playerSessionExists: boolean;
  bootstrapExpected: boolean;
  decision: PlayerSessionLoginDecision | 'deny';
  reason: string;
}) {
  console.info('[LOGIN_SQL_DECISION]', values);
}
