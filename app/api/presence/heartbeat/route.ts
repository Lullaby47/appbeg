import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { isCacheSqlAuthoritative, logCacheSqlRead } from '@/lib/server/cacheSqlRead';
import { upsertUserPresenceCache } from '@/lib/sql/userPresenceCache';

export const runtime = 'nodejs';

const ROUTE = '/api/presence/heartbeat';
const HEARTBEAT_MIN_INTERVAL_MS = 10_000;

const globalPresenceHeartbeat = globalThis as typeof globalThis & {
  __appbegPresenceHeartbeatLastSeen?: Map<string, number>;
};

function shouldWritePresenceHeartbeat(uid: string) {
  if (!globalPresenceHeartbeat.__appbegPresenceHeartbeatLastSeen) {
    globalPresenceHeartbeat.__appbegPresenceHeartbeatLastSeen = new Map();
  }
  const now = Date.now();
  const lastSeen = globalPresenceHeartbeat.__appbegPresenceHeartbeatLastSeen.get(uid) || 0;
  if (now - lastSeen < HEARTBEAT_MIN_INTERVAL_MS) {
    return false;
  }
  globalPresenceHeartbeat.__appbegPresenceHeartbeatLastSeen.set(uid, now);
  return true;
}

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
  const shouldWrite = shouldWritePresenceHeartbeat(auth.user.uid);
  const ok = shouldWrite ? await upsertUserPresenceCache(auth.user.uid) : true;
  const durationMs = Date.now() - startedAt;

  if (sqlReadMode) {
    console.info('[PRESENCE_SQL_HEARTBEAT]', {
      uid: auth.user.uid,
      role: auth.user.role,
      source: 'sql',
      firestoreAttempted: false,
      durationMs,
      deduped: !shouldWrite,
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
    deduped: !shouldWrite,
  });

  return NextResponse.json({
    ok,
    source: 'sql',
    firestore_fallback: false,
  });
}
