import 'server-only';

import type { DocumentSnapshot } from 'firebase-admin/firestore';

import {
  cleanText,
  getPlayerMirrorPool,
  runMirrorPoolQuery,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

export type CachedUserPresence = {
  uid: string;
  lastSeenAt: string;
};

export async function upsertUserPresenceCache(uid: string, lastSeenAt: Date = new Date()) {
  const db = getPlayerMirrorPool();
  const cleanUid = cleanText(uid);
  if (!db || !cleanUid) {
    return false;
  }

  try {
    await db.query(
      `
        INSERT INTO public.user_presence_cache (
          uid, last_seen_at, source, mirrored_at, deleted_at
        )
        VALUES ($1, $2::timestamptz, 'api', now(), NULL)
        ON CONFLICT (uid) DO UPDATE SET
          last_seen_at = EXCLUDED.last_seen_at,
          source = 'api',
          mirrored_at = now(),
          deleted_at = NULL
      `,
      [cleanUid, lastSeenAt.toISOString()]
    );
    return true;
  } catch (error) {
    console.warn('[USER_PRESENCE_CACHE] upsert failed', { uid: cleanUid, error });
    return false;
  }
}

export async function mirrorUserPresenceSnapshot(snap: DocumentSnapshot) {
  if (!snap.exists) {
    return false;
  }
  const data = snap.data() as { lastSeenAt?: unknown };
  const lastSeenAt = toIsoString(data.lastSeenAt);
  if (!lastSeenAt) {
    return false;
  }
  return upsertUserPresenceCache(snap.id, new Date(lastSeenAt));
}

export async function readUserPresenceCacheByUids(
  uids: string[]
): Promise<CachedUserPresence[] | null> {
  const db = getPlayerMirrorPool();
  const cleanUids = [...new Set(uids.map((uid) => cleanText(uid)).filter(Boolean))];
  if (!db || !cleanUids.length) {
    return [];
  }

  try {
    const { rows } = await runMirrorPoolQuery<Record<string, unknown>>(
      db,
      `
        SELECT uid, last_seen_at
        FROM public.user_presence_cache
        WHERE deleted_at IS NULL
          AND uid = ANY($1::text[])
      `,
      [cleanUids],
      { context: 'user_presence_cache_read' }
    );
    return rows
      .map((row) => {
        const uid = cleanText(row.uid);
        const lastSeenAt = toIsoString(row.last_seen_at);
        if (!uid || !lastSeenAt) {
          return null;
        }
        return { uid, lastSeenAt };
      })
      .filter((row): row is CachedUserPresence => Boolean(row));
  } catch (error) {
    console.warn('[USER_PRESENCE_CACHE] read failed', { count: cleanUids.length, error });
    return null;
  }
}
