'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  documentId,
  onSnapshot,
  query,
  Timestamp,
  where,
} from 'firebase/firestore';

import { getLocalAppSessionId } from '@/features/auth/appSession';
import { getLocalPlayerSessionId } from '@/features/auth/playerSession';
import { getCachedSessionUser } from '@/features/auth/sessionUser';
import { fetchChatApi } from '@/lib/client/chatLogoutDiagnostics';
import { getSqlApiReadHeaders } from '@/lib/client/sqlApiHeaders';
import { checkPlayerPollRole } from '@/lib/client/playerPollGuard';
import { assertClientFirestoreDisabled } from '@/lib/client/clientFirestoreGuard';
import { isClientSqlReadMode, logClientFirestoreSkipped } from '@/lib/client/sqlReadMode';
import { db } from '@/lib/firebase/client';

/** A user is "online" if their client wrote presence within this window. */
export const PRESENCE_TTL_MS = 120_000;

const PRESENCE_POLL_MS = 15_000;

export function isPresenceTimeOnline(
  lastSeenMs: number | null | undefined,
  now: number = Date.now()
) {
  if (lastSeenMs == null || !Number.isFinite(lastSeenMs)) {
    return false;
  }
  return now - lastSeenMs < PRESENCE_TTL_MS;
}

const CHUNK = 30;

function stableUidListKey(uids: string[]) {
  return JSON.stringify(
    [...new Set((uids || []).map((u) => String(u || '').trim()).filter(Boolean))].sort()
  );
}

async function fetchPresenceBatch(uids: string[], options?: { logAsChatApi?: boolean }) {
  if (!uids.length) {
    return {} as Record<string, number | null>;
  }
  const url = `/api/presence/batch?uids=${encodeURIComponent(uids.join(','))}`;
  const headers = await getSqlApiReadHeaders(false);
  const cached = getCachedSessionUser();
  const requestContext = {
    role: cached?.role ?? null,
    uid: cached?.uid ?? null,
    hasAppSessionId: Boolean(getLocalAppSessionId()),
    hasPlayerSessionId: Boolean(getLocalPlayerSessionId()),
    headersSent: Object.keys(headers),
  };
  const response = options?.logAsChatApi
    ? await fetchChatApi(
        url,
        {
          method: 'GET',
          headers,
          cache: 'no-store',
        },
        requestContext
      )
    : await fetch(url, {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
  const payload = (await response.json().catch(() => ({}))) as {
    presence?: Array<{ uid?: string; lastSeenAt?: string }>;
  };
  if (!response.ok) {
    return {};
  }
  const out: Record<string, number | null> = {};
  for (const uid of uids) {
    out[uid] = null;
  }
  for (const row of payload.presence || []) {
    const uid = String(row.uid || '').trim();
    const ms = row.lastSeenAt ? Date.parse(row.lastSeenAt) : NaN;
    if (uid) {
      out[uid] = Number.isFinite(ms) ? ms : null;
    }
  }
  return out;
}

/**
 * Real-time map of whether each uid is "online" (fresh lastSeen) for UI dots.
 * Ensure {@link UserPresenceSync} (or equivalent heartbeat) is mounted for the signed-in app.
 */
export function usePresenceOnlineMap(
  uids: string[],
  options?: { requirePlayerRole?: boolean }
) {
  const contentKey = stableUidListKey(uids);
  const uniqueSorted = useMemo(
    () => (contentKey ? (JSON.parse(contentKey) as string[]) : []),
    [contentKey]
  );
  const key = contentKey;

  const [lastSeenMsByUid, setLastSeenMsByUid] = useState<Record<string, number | null>>(
    {}
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (uniqueSorted.length === 0) {
      setLastSeenMsByUid({});
      return;
    }

    if (isClientSqlReadMode()) {
      logClientFirestoreSkipped('user_presence_listener', { count: uniqueSorted.length });
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const poll = async () => {
        if (cancelled) {
          return;
        }
        if (options?.requirePlayerRole) {
          const sessionUser = await checkPlayerPollRole('player_presence');
          if (!sessionUser) {
            cancelled = true;
            if (timer != null) {
              clearTimeout(timer);
              timer = null;
            }
            return;
          }
        }
        try {
          for (let i = 0; i < uniqueSorted.length; i += CHUNK) {
            const chunk = uniqueSorted.slice(i, i + CHUNK);
            const batch = await fetchPresenceBatch(chunk, {
              logAsChatApi: options?.requirePlayerRole === true,
            });
            if (cancelled) {
              return;
            }
            setLastSeenMsByUid((prev) => ({ ...prev, ...batch }));
          }
        } finally {
          if (!cancelled) {
            timer = setTimeout(() => {
              void poll();
            }, PRESENCE_POLL_MS);
          }
        }
      };

      void poll();
      return () => {
        cancelled = true;
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    }

    if (assertClientFirestoreDisabled('user_presence_listener', 'onSnapshot')) {
      setLastSeenMsByUid({});
      return;
    }

    const unsubs: (() => void)[] = [];

    for (let i = 0; i < uniqueSorted.length; i += CHUNK) {
      const chunk = uniqueSorted.slice(i, i + CHUNK);
      const q = query(
        collection(db, 'userPresence'),
        where(documentId(), 'in', chunk)
      );

      unsubs.push(
        onSnapshot(q, (snap) => {
          setLastSeenMsByUid((prev) => {
            const next = { ...prev };
            for (const id of chunk) {
              const docSnap = snap.docs.find((d) => d.id === id);
              if (!docSnap) {
                next[id] = null;
                continue;
              }
              const ls = docSnap.data().lastSeenAt as Timestamp | undefined;
              next[id] = ls?.toMillis() ?? null;
            }
            return next;
          });
        })
      );
    }

    return () => {
      for (const u of unsubs) {
        u();
      }
    };
  }, [key, uniqueSorted, options?.requirePlayerRole]);

  return useMemo(() => {
    const now = Date.now() + tick * 0;
    const out: Record<string, boolean> = {};
    for (const uid of uniqueSorted) {
      out[uid] = isPresenceTimeOnline(lastSeenMsByUid[uid] ?? null, now);
    }
    return out;
  }, [uniqueSorted, lastSeenMsByUid, tick]);
}
