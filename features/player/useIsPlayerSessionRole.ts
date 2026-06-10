'use client';

import { useEffect, useRef, useState } from 'react';

import { logPlayerPollBlockedRole } from '@/lib/client/playerPollGuard';
import { getCachedSessionUser, getSessionUserOnce } from '@/features/auth/sessionUser';

const ROLE_SYNC_MS = 3_000;

async function resolveIsPlayerRole() {
  const cached = getCachedSessionUser();
  if (cached?.role === 'player') {
    return { isPlayer: true, uid: cached.uid, role: cached.role as string };
  }

  const fetched = await getSessionUserOnce().catch(() => null);
  if (fetched?.role === 'player') {
    return { isPlayer: true, uid: fetched.uid, role: fetched.role };
  }

  return {
    isPlayer: false,
    uid: fetched?.uid ?? cached?.uid ?? null,
    role: fetched?.role ?? cached?.role ?? null,
  };
}

export function useIsPlayerSessionRole() {
  const wasPlayerRef = useRef(getCachedSessionUser()?.role === 'player');
  const [isPlayerRole, setIsPlayerRole] = useState(wasPlayerRef.current);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sync = async () => {
      const resolved = await resolveIsPlayerRole();
      if (cancelled) {
        return;
      }

      if (wasPlayerRef.current && !resolved.isPlayer) {
        logPlayerPollBlockedRole({
          pollName: 'player_page_role_sync',
          uid: resolved.uid,
          role: resolved.role,
          reason: 'role_changed_away_from_player',
        });
      }

      wasPlayerRef.current = resolved.isPlayer;
      setIsPlayerRole(resolved.isPlayer);
    };

    void sync();

    const schedule = () => {
      timer = setTimeout(() => {
        void sync().finally(() => {
          if (!cancelled) {
            schedule();
          }
        });
      }, ROLE_SYNC_MS);
    };
    schedule();

    return () => {
      cancelled = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);

  return isPlayerRole;
}
