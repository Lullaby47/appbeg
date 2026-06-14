'use client';

import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';
import {
  getLocalPlayerSessionId,
  getPlayerSessionGeneration,
} from '@/features/auth/playerSession';
import {
  handleStalePlayerFetchError,
  isPlayerSessionStale,
  markPlayerSessionStale,
  registerPlayerRuntimeStopper,
} from '@/lib/client/playerStaleSession';

export function logPlayerPollBlockedRole(values: {
  pollName: string;
  uid: string | null;
  role: string | null;
  reason?: string;
}) {
  console.info('[PLAYER_POLL_BLOCKED_ROLE]', {
    pollName: values.pollName,
    uid: values.uid,
    role: values.role,
    expectedRole: 'player',
    reason: values.reason || 'non_player_role',
  });
}

export async function checkPlayerPollRole(pollName: string) {
  if (isPlayerSessionStale()) {
    return null;
  }

  const pathname = typeof window === 'undefined' ? '' : window.location.pathname || '';
  const isPlayerRoute = pathname === '/player' || pathname.startsWith('/player/');
  if (!isPlayerRoute) {
    console.info('[PLAYER_SESSION_STATUS] skippedNonPlayerRoute', {
      pollName,
      pathname: pathname || null,
      hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    });
    return null;
  }

  const cached = getCachedSessionUser();
  if (cached?.role === 'player') {
    return cached;
  }

  const fetched = await getSessionUserOnce().catch(() => null);
  if (fetched?.role === 'player') {
    return fetched;
  }

  logPlayerPollBlockedRole({
    pollName,
    uid: fetched?.uid ?? cached?.uid ?? null,
    role: fetched?.role ?? cached?.role ?? null,
  });
  console.info('[PLAYER_SESSION_STATUS] skippedNonPlayerRole', {
    pollName,
    uid: fetched?.uid ?? cached?.uid ?? null,
    role: fetched?.role ?? cached?.role ?? null,
    hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
  });
  return null;
}

function shouldStopPollForSessionGuard(
  pollName: string,
  generationAtStart: number,
  sessionIdAtStart: string
) {
  if (isPlayerSessionStale()) {
    return true;
  }

  const currentSessionId = getLocalPlayerSessionId();
  const currentGeneration = getPlayerSessionGeneration();

  if (
    currentGeneration !== generationAtStart ||
    !currentSessionId ||
    currentSessionId !== sessionIdAtStart
  ) {
    markPlayerSessionStale('player_session_generation_stale', pollName, {
      skipRedirect: true,
    });
    return true;
  }

  return false;
}

export function createPlayerScopedPoll(input: {
  pollName: string;
  intervalMs: number;
  onTick: () => Promise<void>;
  onError?: (error: Error) => void;
}) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const generationAtStart = getPlayerSessionGeneration();
  const sessionIdAtStart = getLocalPlayerSessionId();

  const stop = () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const unregister = registerPlayerRuntimeStopper(stop);

  const tick = async () => {
    if (cancelled || shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)) {
      stop();
      return;
    }

    const sessionUser = await checkPlayerPollRole(input.pollName);
    if (!sessionUser) {
      stop();
      return;
    }

    try {
      await input.onTick();
    } catch (error) {
      if (!cancelled) {
        if (
          handleStalePlayerFetchError(input.pollName, error, sessionIdAtStart)
        ) {
          stop();
          return;
        }
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (
        !cancelled &&
        !shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)
      ) {
        timer = setTimeout(() => {
          void tick();
        }, input.intervalMs);
      }
    }
  };

  void (async () => {
    if (shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)) {
      stop();
      return;
    }
    const sessionUser = await checkPlayerPollRole(input.pollName);
    if (!sessionUser || cancelled) {
      return;
    }
    await tick();
  })();

  return () => {
    unregister();
    stop();
  };
}

export function startPlayerRoleGuardedInterval(input: {
  pollName: string;
  intervalMs: number;
  onTick: () => void;
}) {
  let cancelled = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  const generationAtStart = getPlayerSessionGeneration();
  const sessionIdAtStart = getLocalPlayerSessionId();

  const stop = () => {
    cancelled = true;
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const unregister = registerPlayerRuntimeStopper(stop);

  void (async () => {
    if (shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)) {
      stop();
      return;
    }

    const sessionUser = await checkPlayerPollRole(input.pollName);
    if (!sessionUser || cancelled) {
      return;
    }

    intervalId = setInterval(() => {
      void (async () => {
        if (
          cancelled ||
          shouldStopPollForSessionGuard(input.pollName, generationAtStart, sessionIdAtStart)
        ) {
          stop();
          return;
        }
        const current = await checkPlayerPollRole(input.pollName);
        if (!current) {
          stop();
          return;
        }
        input.onTick();
      })();
    }, input.intervalMs);
  })();

  return () => {
    unregister();
    stop();
  };
}
