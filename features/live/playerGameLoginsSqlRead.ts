'use client';

import type { PlayerGameLogin } from '@/features/games/playerGameLogins';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { createPlayerScopedPoll } from '@/lib/client/playerPollGuard';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';

const POLL_MS = 10_000;

function mapCachedLogin(row: Record<string, unknown>): PlayerGameLogin {
  return {
    id: String(row.id || ''),
    playerUid: String(row.playerUid || ''),
    playerUsername: String(row.playerUsername || ''),
    gameName: String(row.gameName || ''),
    gameUsername: String(row.gameUsername || ''),
    gamePassword: String(row.gamePassword || ''),
    frontendUrl: String(row.frontendUrl || '').trim() || undefined,
    siteUrl: String(row.siteUrl || '').trim() || undefined,
    coadminUid: String(row.coadminUid || ''),
    createdBy: String(row.createdBy || ''),
    createdAt: row.createdAt ?? null,
  };
}

async function fetchPlayerGameLogins(scope: 'player' | 'coadmin', uid: string) {
  const query =
    scope === 'player'
      ? `playerUid=${encodeURIComponent(uid)}`
      : `coadminUid=${encodeURIComponent(uid)}`;
  const response = await fetch(`/api/player-game-logins/cache?${query}`, {
    method: 'GET',
    headers: await getSqlApiReadHeaders(false),
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    playerGameLogins?: Array<Record<string, unknown>>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load player game logins.');
  }
  return (payload.playerGameLogins || []).map(mapCachedLogin);
}

export function attachPlayerGameLoginsSqlPoll(input: {
  scope: 'player' | 'coadmin';
  uid: string;
  onChange: (logins: PlayerGameLogin[]) => void;
  onError?: (error: Error) => void;
  initialDelayMs?: number;
}) {
  logClientFirestoreSkipped('player_game_logins_listener', {
    scope: input.scope,
    uid: input.uid,
  });

  const runPoll = async () => {
    const logins = await fetchPlayerGameLogins(input.scope, input.uid);
    input.onChange(logins);
  };

  if (input.scope === 'player') {
    console.info('[POLLER_RETAINED]', {
      pollName: 'player_game_logins',
      reason: 'safety_refresh_for_credential_updates_not_covered_by_initial_base_data',
      initialDelayMs: Math.max(0, Number(input.initialDelayMs || 0)),
    });
    return createPlayerScopedPoll({
      pollName: 'player_game_logins',
      intervalMs: POLL_MS,
      onTick: runPoll,
      onError: input.onError,
      initialDelayMs: input.initialDelayMs,
    });
  }

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      await runPoll();
    } catch (error) {
      if (!cancelled) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, POLL_MS);
      }
    }
  };

  void tick();

  return () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function isPlayerGameLoginsSqlReadEnabled() {
  return isClientSqlReadMode();
}
