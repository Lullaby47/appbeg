import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { isCacheSqlAuthoritative, logCacheSqlRead } from '@/lib/server/cacheSqlRead';
import { upsertUserPresenceCache } from '@/lib/sql/userPresenceCache';

export const runtime = 'nodejs';

const ROUTE = '/api/presence/heartbeat';

export async function POST(request: Request) {
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

  const startedAt = Date.now();
  const sqlReadMode = isCacheSqlAuthoritative();
  const ok = await upsertUserPresenceCache(auth.user.uid);
  const durationMs = Date.now() - startedAt;

  if (sqlReadMode) {
    console.info('[PRESENCE_SQL_HEARTBEAT]', {
      uid: auth.user.uid,
      role: auth.user.role,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
    });
    return NextResponse.json({
      ok,
      source: 'sql',
      firestore_fallback: false,
    });
  }

  logCacheSqlRead(ROUTE, {
    uid: auth.user.uid,
    ok,
    durationMs,
  });

  return NextResponse.json({
    ok,
    source: 'sql',
    firestore_fallback: false,
  });
}
