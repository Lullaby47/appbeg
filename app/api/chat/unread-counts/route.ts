import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import { readConversationsCacheForUser } from '@/lib/sql/conversationsCache';

const ROUTE = '/api/chat/unread-counts';

export async function GET(request: Request) {
  const startedAt = Date.now();
  const auth = await requireApiUser(request, [
    'admin',
    'coadmin',
    'staff',
    'carer',
    'player',
  ]);
  if ('response' in auth) {
    return auth.response;
  }

  const conversations = await readConversationsCacheForUser(auth.user.uid);
  const counts: Record<string, number> = {};

  for (const conversation of conversations || []) {
    const unread = Number(conversation.unreadCounts[auth.user.uid] || 0);
    if (unread <= 0) {
      continue;
    }
    const otherUid = conversation.participantUids.find((uid) => uid !== auth.user.uid);
    if (!otherUid) {
      continue;
    }
    counts[otherUid] = unread;
  }

  if (isCacheSqlAuthoritative()) {
    logCacheSqlRead(ROUTE, {
      uid: auth.user.uid,
      count: Object.keys(counts).length,
      durationMs: Date.now() - startedAt,
    });
    if (conversations === null) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'conversations', { uid: auth.user.uid });
    }
  }

  return NextResponse.json({
    unreadCounts: counts,
    source: 'postgres',
    firestore_fallback: false,
  });
}
