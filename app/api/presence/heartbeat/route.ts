import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { isAuthSqlReadEnabled } from '@/lib/server/authSqlRead';
import { logFirestoreTouch } from '@/lib/server/firestoreTouchAudit';
import { upsertUserPresenceCache } from '@/lib/sql/userPresenceCache';

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

  const sqlReadMode = isAuthSqlReadEnabled();
  const ok = await upsertUserPresenceCache(auth.user.uid);
  if (sqlReadMode) {
    logFirestoreTouch({
      firestore_touch_type: 'legacy_read_remove_now',
      route: ROUTE,
      operation: 'write',
      collection: 'userPresence',
      skipped: true,
      sql_read_mode: true,
      details: { uid: auth.user.uid, reason: 'sql_presence_heartbeat' },
    });
  }

  return NextResponse.json({
    ok,
    source: 'sql',
    firestore_fallback: false,
  });
}
