'use client';

import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';

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
  return null;
}

export function createPlayerScopedPoll(input: {
  pollName: string;
  intervalMs: number;
  onTick: () => Promise<void>;
  onError?: (error: Error) => void;
}) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    cancelled = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (cancelled) {
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
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, input.intervalMs);
      }
    }
  };

  void (async () => {
    const sessionUser = await checkPlayerPollRole(input.pollName);
    if (!sessionUser || cancelled) {
      return;
    }
    await tick();
  })();

  return stop;
}

export function startPlayerRoleGuardedInterval(input: {
  pollName: string;
  intervalMs: number;
  onTick: () => void;
}) {
  let cancelled = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    cancelled = true;
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  void (async () => {
    const sessionUser = await checkPlayerPollRole(input.pollName);
    if (!sessionUser || cancelled) {
      return;
    }

    intervalId = setInterval(() => {
      void (async () => {
        if (cancelled) {
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

  return stop;
}
