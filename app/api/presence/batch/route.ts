import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  isCacheSqlAuthoritative,
  logCacheFirestoreFallbackBlocked,
  logCacheSqlRead,
} from '@/lib/server/cacheSqlRead';
import { readUserPresenceCacheByUids } from '@/lib/sql/userPresenceCache';

export const runtime = 'nodejs';

const ROUTE = '/api/presence/batch';

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

  const uids = String(new URL(request.url).searchParams.get('uids') || '')
    .split(',')
    .map((uid) => uid.trim())
    .filter(Boolean)
    .slice(0, 120);

  if (!uids.length) {
    return apiError('uids query parameter is required.', 400);
  }

  const presence = await readUserPresenceCacheByUids(uids);
  if (isCacheSqlAuthoritative()) {
    logCacheSqlRead(ROUTE, {
      count: presence?.length || 0,
      durationMs: Date.now() - startedAt,
    });
    if (presence === null) {
      logCacheFirestoreFallbackBlocked(ROUTE, 'user_presence_cache', {
        count: uids.length,
        reason: 'postgres_unavailable',
      });
    }
  }

  return NextResponse.json({
    presence: presence || [],
    source: 'postgres',
    firestore_fallback: false,
  });
}
