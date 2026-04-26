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

import { db } from '@/lib/firebase/client';

/** A user is "online" if their client wrote presence within this window. */
export const PRESENCE_TTL_MS = 120_000;

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

/**
 * Real-time map of whether each uid is "online" (fresh lastSeen) for UI dots.
 * Ensure {@link UserPresenceSync} (or equivalent heartbeat) is mounted for the signed-in app.
 */
function stableUidListKey(uids: string[]) {
  return JSON.stringify(
    [...new Set((uids || []).map((u) => String(u || '').trim()).filter(Boolean))].sort()
  );
}

export function usePresenceOnlineMap(uids: string[]) {
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
  }, [key, uniqueSorted]);

  return useMemo(() => {
    const now = Date.now() + tick * 0;
    const out: Record<string, boolean> = {};
    for (const uid of uniqueSorted) {
      out[uid] = isPresenceTimeOnline(lastSeenMsByUid[uid] ?? null, now);
    }
    return out;
  }, [uniqueSorted, lastSeenMsByUid, tick]);
}
